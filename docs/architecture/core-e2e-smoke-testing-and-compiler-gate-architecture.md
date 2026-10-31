# 巡影 (Mediary Scout) 端对端核心冒烟测试与编译期门禁架构设计

> 文档版本: v1.0.0  
> 核心目标: 根治 Next.js Turbopack 懒加载编译机制下，启动后仅在访问特定路由时才暴露的「模块未导出」、「相对引用悬空」、「500 运行时异常」及「Edge 运行时警告」等编译与契约退化问题。

---

## 1. 背景与根因剖析 (Root-Cause Analysis)

### 1.1 Next.js Turbopack 懒编译特性
Next.js 开发模式（`next dev --turbopack`）采用**按需即时编译 (On-Demand Lazy Compilation)**：
1. 服务启动时（`Ready in 400ms`），仅仅加载了 `instrumentation.ts` 与直接注册项；
2. 即使 `/api/health` 返回 `200 OK`，其余 95% 的页面（如 `/`、`/settings`、`/show/[tmdbId]`）与 API 路由（如 `/api/settings/attention`、`/api/notifications/meta`、`/api/activity`）**完全未被 Turbopack 解析与编译**；
3. 直到浏览器真实发起网络请求，Turbopack 才开始递归解析 AST。此时若存在缺失的导出符号（例如 `isMultiUserEnabled` 或 `formatNetworkError`）或悬空的相对路径引用，服务端立即抛出 `Ecmascript file had an error` 并返回 HTTP 500。

### 1.2 现有门禁防护链的盲区
| 防护层级 | 当前覆盖能力 | 对 Turbopack 懒编译隐患的盲区 |
| :--- | :--- | :--- |
| **根目录 `tsc --noEmit`** | 校验 `packages/**/*.ts` 与 `tests/` | 默认排除 `apps/web`（因历史测试文件松散类型），无法拦截 web 内部的引用缺失 |
| **`check-layout.mjs`** | 校验 L0 物理目录结构与单文件行数上限 | 不分析 AST 符号导入导出 |
| **`check-server-actions.mjs`** | 校验 `"use server"` 纯函数性与 Edge 泄露 | 仅覆盖 server actions 与 instrumentation |
| **`check-facades.mjs`** (升级前) | 校验硬编码的部分核心导出清单 | 未覆盖所有相对文件解析与跨模块命名导出一致性 |
| **单元测试 (Vitest)** | 各自 Mock 依赖运行业务逻辑 | 无法感知真实的 Next.js 打包器与路由文件系统映射 |

---

## 2. 业界主流解决方案对比与选型

经对业界前沿方案（Next.js 官方测试链、Vercel CI/CD、Shopify/Airbnb 微前端端对端发布体系）进行对比调研：

| 方案 | 机制原理 | 优点 | 缺点 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **A. 全量 Webpack/Turbopack Prebuild (`next build`)** | 每次提测前执行完整生产构建 | 100% 静态扫描所有路由编译期错误 | 极慢（需要 20~40 秒），开发体验差，无法秒级反馈 | 生产发版 CI/CD 阶段 |
| **B. 真实浏览器 Playwright 巡检** | 驱动 Chromium 逐个点击页面 | 校验真实 DOM 渲染与前端 Hydration | 依赖浏览器二进制，执行耗时（10~25 秒），环境要求高 | 夜间全量回归与 E2E 交付 |
| **C. 静态 AST 路由图爬虫 (Tier-1 Static Pre-flight)** | 无需启动服务，静态解析全部路由导入导出的物理存在性 | 极速（< 50ms），零外部依赖，100% 确定性发现缺符号与死链接 | 无法覆盖动态计算与运行时上下文 | 提交代码与 `npm run gate` 必选 |
| **D. 核心端对端真实冒烟探测器 (Tier-2 Real HTTP Smoke Prober)** | 启动/复用开发实例，通过原生 HTTP 管道瞬时预热核心路由矩阵，拦截打包器日志 | 触发真实的 Turbopack 编译，拦截 500 与打包错误，执行耗时 < 3s | 需管理进程生命周期 | 调试启动与快速验收必备 |

### 架构决策：双层纵深防御体系 (Two-Tier Defense In Depth)
采用 **「Tier-1 静态物理闭环门禁 (< 50ms) + Tier-2 真实核心冒烟探测器 (< 3s)」** 组合方案：
1. **第一层 (Static Pre-flight Gate)**：静态扫描 `apps/web` 全量相对引用、内部跨包导出、核心门面符号，在代码进入运行态前掐断 99% 的静态不一致。
2. **第二层 (E2E Core Smoke Prober)**：提供一键执行的端对端冒烟器，复用或拉起开发服务，并发预热并探测核心 SSR 页面与 REST API，强行触发 Turbopack 编译并拦截任何打包告警与 500 异常。

---

## 3. 设计模式与核心架构

为了保证冒烟测试工具具备生产级健壮性、零外部依赖（Node 22 原生）、可扩展性与跨平台（Windows/macOS/Linux）兼容，全面引入经典设计模式：

```
                    ┌──────────────────────────────────────────────┐
                    │      Smoke Runner Lifecycle (FSM 状态机)       │
                    └──────────────────────┬───────────────────────┘
                                           │
         ┌───────────────┬─────────────────┼────────────────┬───────────────┐
         ▼               ▼                 ▼                ▼               ▼
    [1. PREFLIGHT] ──> [2. ATTACH/SPAWN] ──> [3. HEALTH] ──> [4. PROBE] ──> [5. AUDIT & TEARDOWN]
    环境与配置检查      适配器模式选择服务      轮询健康入口     策略模式路由矩阵   打包日志拦截 & 进程自愈
```

### 3.1 状态机模式 (Finite State Machine - FSM)
管理冒烟测试的完整生命周期，确保在任何异常、Ctrl+C 或断言失败时均能可靠自愈，永不遗留僵尸进程：
- `STATE_INIT`：解析参数（目标端口、是否独立启动、超时阈值）；
- `STATE_DISCOVERY`：探测目标端口（默认 3001 或临时 3009）；
- `STATE_ADAPT`：根据端口占用状态决定「复用正在运行的实例」或「冷启动临时实例」；
- `STATE_HEALTH_WAIT`：以指数退避轮询 `/api/health` 直至 HTTP 200；
- `STATE_PROBE_MATRIX`：并发/流水线调度路由探测策略；
- `STATE_LOG_HARVEST`：分析 Next/Turbopack 标准输出与错误流，匹配 `Ecmascript file had an error` 等异常标志；
- `STATE_TEARDOWN`：若是临时实例，通过进程树清理（Windows `taskkill /F /T` / POSIX `kill -9`）安全释放资源；
- `STATE_REPORT`：输出格式化诊断报告，返回精确退出码（0 = 通过，1 = 冒烟失败）。

### 3.2 适配器模式 (Adapter Pattern)
抹平宿主服务与运行模式的差异：
- `LiveServerAdapter`：探测到本地已有 `dev.bat` 正在运行（3001 端口），直接无缝挂载进行测试，测试完成后**保持原有服务运行**；
- `EphemeralServerAdapter`：本地无服务时，自动拉起一个使用沙箱测试数据库（`run/smoke-test.db`）的隔离 Next 进程，测试完毕后**全自动销毁释放**；
- `ProcessTreeAdapter`：封装跨平台进程治理（解决 Windows 下 Node CVE-2024-27980 的 `spawn EINVAL` 与 DEP0190 弃用告警）。

### 3.3 策略模式 (Strategy Pattern)
针对不同类型的核心路由采用差异化的探针与校验策略：
- `SsrPageStrategy`：针对 SSR 页面（`/`、`/settings`），校验 HTTP 状态码为 200，响应 Header 为 `text/html`，内容包含完整骨架，且无未捕获组件渲染异常；
- `RestApiStrategy`：针对核心 API（`/api/settings/attention`、`/api/notifications/meta`、`/api/activity`），校验其即使在未认证或初始状态下也应返回规范的 200 或 401 JSON，绝不能崩为 500；
- `TurbopackCompilerTrapStrategy`：挂载子进程输出流的实时监控策略，捕获：
  - `Export .* doesn't exist in target module`
  - `Module not found: Can't resolve`
  - `Only async functions are allowed to be exported in a "use server" file`
  - `Ecmascript file had an error`
  - `A Node.js module is loaded .* which is not supported in the Edge Runtime`

---

## 4. 关键实现与落地清单

1. **根因修复 (Immediate Fixes)**:
   - 补齐 `apps/web/platform/next-context/auth-chain.ts` 与 `apps/web/lib/auth-chain.ts` 的 `isMultiUserEnabled` 导出；
   - 将 `instrumentation.ts` 的 Node 专有逻辑完全隔离至 `instrumentation-node.ts`，消除 Turbopack Edge 编译告警。
2. **Tier-1 增强门禁 (`tools/gates/check-facades.mjs`)**:
   - 动态提取 `@media-track/workflow`、`@media-track/contracts`、`@media-track/shared` 全部导出符号；
   - 静态扫描 `apps/web` 内部全部相对文件导入，校验磁盘物理存在性；
   - 校验跨包具名导入一致性，在编译前拦截一切缺失导出。
3. **Tier-2 真实冒烟器 (`tools/runner/smoke-tester.mjs` + `smoke.bat`)**:
   - 原生 Node 22 实现，零第三方依赖；
   - 自动适配复用或瞬时冷启动；
   - 覆盖核心路由矩阵，拦截并上报 Turbopack 编译报错与 500 异常；
   - 集成到 package.json 脚本：`npm run test:smoke`。
4. **自动化与回归守护**:
   - Vitest 测试用例 `tools/gates/check-facades.test.mjs` 与 `tools/runner/smoke-tester.test.mjs`；
   - 统一加入 `npm run gate`。
