# 巡影 · Mediary Scout 工具链模块化、平铺目录治理与本地极速启动器架构方案

> **编制时间**：2026-10-31  
> **文档位置**：`docs/architecture/tools-modularization-and-dev-runner-architecture.md`  
> **对标标准**：`SoftwareArchitecture/backend`、Node.js 22+ 现代化工程化最佳实践、Windows/POSIX 跨平台双模运行规范

---

## 一、需求背景与核心问题诊断

在完成了核心业务库 `packages/workflow`、前端组件 `apps/web/components`、Worker 服务 `workers/scout-connect` 及测试/文档的垂直切片重构后，系统在**工程运维与本地开发调试体验**上仍存在以下三大诉求：

### 1.1 `tools/` 工具链平铺与职责混杂
- **现状**：`tools/` 根目录下平铺了 9 个不同职责的脚本文件，混合了门禁质检（`check-layout.mjs`、`check-style-tokens.mjs` 等）、自定义 ESLint 规则与单测（`eslint-local-rules.mjs`）、上游同步审计（`audit-upstream.mjs`）以及跨包一致性看守（`update-source-parity.test.mjs`）。
- **诉求**：建立具有领域归属的子目录（`gates/`、`linter/`、`upstream/`、`parity/`、`runner/`），消除工具链的平铺乱象。

### 1.2 仓库全局平铺隐患的最终审计
- 需要系统性盘点整个单体仓库（Monorepo），除此前已经治理的重灾区外，澄清剩余如 `scripts/`、`apps/web/lib/` 等目录的定位、合理性及后续治理节奏。

### 1.3 Windows 环境下本地 Web 服务调试启动的痛点
- **现状痛点 1（跨平台断层）**：工程原有的本地启动脚本 [`scripts/run-local-real.sh`](file:///e:/WorkProject/Node/_Project/mediary-scout/scripts/run-local-real.sh) 是基于 Linux/macOS 编写的 Shell 脚本，强依赖 `setsid`、`ps -o pgid=`、`kill -TERM -$pgid` 等 POSIX 专有指令。在 Windows 本地环境下无法通过双击或原生 CMD/PowerShell 直接运行。
- **现状痛点 2（无谓构建等待，启动缓慢）**：每次运行 `npm run dev:web` 都会无条件触发 `npm run build:workflow`，即使没有任何 TypeScript 源码变更，也会付出数秒的 `tsc` 全量编译开销，拖慢本地调试节奏。
- **现状痛点 3（僵尸进程与端口冲突 `EADDRINUSE`）**：在 Windows 调试环境中，通过终端关闭或热重载时，Node.js 子进程常常未能完全释放端口 3001/3000，再次启动时报错退出。开发者必须手动打开任务管理器或运行 `netstat -ano | findstr 3001` 排查杀进程。
- **现状痛点 4（配置易漂移导致虚假调试）**：如 `run-local-real.sh` 文档所警示，手填环境变量极易抄错成 `fake` 或 `demo` 模式，导致用户在本地搜索“奥特曼”等资源时出现空白结果，把配置错误误当成功能 Bug。

---

## 二、架构设计模式优化与头脑风暴（Brainstorming）

针对本地启动器（Local Dev Runner），如果仅仅编写一个简单的批处理命令，将无法处理状态监控、跨平台端口回收、健康探测与配置防漂移等深层问题。我们引入经典设计模式对启动器进行全方位赋能：

```
                              ┌────────────────────────────────────────┐
                              │         dev.bat / dev-server.mjs       │
                              │          (统一 CLI 门面与编排器)          │
                              └───────────────────┬────────────────────┘
                                                  │
                 ┌────────────────────────────────┼────────────────────────────────┐
                 ▼                                ▼                                ▼
   ┌───────────────────────────┐    ┌───────────────────────────┐    ┌───────────────────────────┐
   │    有限状态机 (FSM)        │    │    策略模式 (Strategy)     │    │    适配器模式 (Adapter)    │
   │  ServerLifecycleFSM       │    │   RunProfileStrategy      │    │  Process & Env Adapter    │
   ├───────────────────────────┤    ├───────────────────────────┤    ├───────────────────────────┤
   │ • PREFLIGHT (环境/DB校验)  │    │ • DevTurbopack (极速HMR)   │    │ • WindowsProcessAdapter   │
   │ • CACHE_CHECK (编译缓存)  │    │ • ProdPreview (生产模拟)   │    │ • PosixProcessAdapter     │
   │ • PORT_RECLAIM (端口回收)  │    │ • MockDemo (纯假数据)      │    │ • EnvParityAdapter        │
   │ • SPAWNING (子进程拉起)    │    └───────────────────────────┘    │   (与桌面/容器保持100%一致)│
   │ • HEALTH_CHECK (健康探测) │                                     └───────────────────────────┘
   │ • RUNNING / SHUTDOWN      │
   └───────────────────────────┘
```

### 2.1 有限状态机模式（Server Lifecycle FSM）
启动器的生命周期是一个典型的状态机驱动流程，确保任何异常均可被捕捉并触发回滚与清理：
1. **`PREFLIGHT`（预检状态）**：校验 Node.js 版本（$\ge 22.13.0$）、确认数据库目录 `run/` 存在。
2. **`CACHE_CHECK`（智能增量编译检查）**：对比 `packages/{workflow,shared}/src/` 源码文件与 `dist/` 的最后修改时间戳（mtime）。若 `dist/` 存在且全量晚于 `src/`，**直接跳过 TypeScript 编译**，启动时间缩短 90%；若有修改才执行 `npm run build:workflow`。
3. **`PORT_RECLAIM`（端口自治回收状态）**：检测指定端口（默认 3001）。若已被占用，自动识别占用进程：属于自身旧实例时通过进程树强制终止；属于第三方服务时报警并提示换端口。
4. **`SPAWNING`（进程拉起状态）**：根据策略注入标准化环境变量，异步启动子进程，并将 PID 写入 `run/server.pid`。
5. **`HEALTH_CHECK`（看门狗健康检测状态）**：每 300ms 轮询 `http://127.0.0.1:<port>/api/health`。设置 30s 守卫超时，若进程提前退出或超时，则提取最近日志抛出精准诊断。
6. **`RUNNING`（就绪状态）**：打印服务面板，自动调用系统默认浏览器打开 Web 界面。
7. **`SHUTDOWN`（优雅退出状态）**：拦截 `SIGINT`（Ctrl+C）与 `SIGTERM`，深度杀死整棵进程树（避免 Windows 孤儿进程），清理 PID 标记。

### 2.2 策略模式（Run Profile Strategy）
支持通过参数快速切换调试策略：
- **`DevTurbopackStrategy`（默认）**：`next dev apps/web --turbopack -p <port>`，提供极致的局部热更新与开发报错遮罩。
- **`ProdPreviewStrategy`（`--prod`）**：`npm run build:web && next start apps/web -p <port>`，模拟真实的生产独立运行包（Standalone），用于上线前真实压测。
- **`DemoMockStrategy`（`--demo`）**：注入 `MEDIA_TRACK_DEMO=true`，完全使用内置模拟数据与模拟存储，无需真实网盘与 TMDB Key。

### 2.3 适配器模式（Process & Env Adapter）
- **`WindowsProcessAdapter`**：在 Windows 环境下使用 `netstat -ano -p tcp` 定位 PID，并通过 `taskkill /F /T /PID <pid>` 级联杀死进程树，彻底根治 Windows 平台特有的端口挂死问题。
- **`PosixProcessAdapter`**：在 macOS/Linux 环境下自动无缝降级为 `lsof` / `kill -TERM -<pgid>`。
- **`EnvParityAdapter`**：严格复用桌面端启动器 [`apps/desktop/src/server-launch.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/desktop/src/server-launch.ts) 的 `buildServerEnv` 契约，统一绑定 `search=tmdb`、`workflow=pansou`、`storage=115`、`agent=vercel-ai`、`sqlitePath=run/mediary.db`、`singleUser=true`，防止开发者在不同端之间产生配置漂移。

---

## 三、方案比对与选型论证

| 考量维度 | 方案 A：引入第三方现成库 (`concurrently` / `pm2` / `cross-env`) | 方案 B：纯原生 Node.js 22+ 编写 `tools/runner/dev-server.mjs` + `.bat` 壳 (本方案) |
| :--- | :--- | :--- |
| **外部依赖负担** | 需安装 3~5 个外部 npm 依赖，增加 node_modules 体积与安全审计风险 | **0 外部依赖**，利用 Node.js 22+ 原生 `node:net`、`node:http`、`node:child_process` |
| **增量编译智能跳过** | 不支持。必须在 package.json 串联 `npm run build:workflow`，每次无条件慢速构建 | **原生支持 mtime 时间戳感知**，源码未动时跳过 `tsc`，秒级拉起 |
| **Windows 端口与进程树回收** | npm 包装进程常导致 Next.js 子进程脱钩挂死，`concurrently` 在 Windows 杀不干净 | **通过 `taskkill /F /T` 精准击杀整棵进程树**，彻底消灭 `EADDRINUSE` |
| **配置一致性与防漂移** | 配置文件分散在各类 runner 配置中，极易脱节 | **与桌面端 `server-launch.ts` 共享同源适配器逻辑**，受自动化单测看守 |
| **便捷性** | 开发者必须进入命令行输入较长的 npm 参数 | **双击 `dev.bat` 即可启动**，同时支持各种灵活命令行参数 |

---

## 四、具体实施执行规划

### 4.1 `tools/` 目录组织重构
重构后的 `tools/` 物理结构：
```text
tools/
├─ gates/                      # 架构与合规门禁
│  ├─ check-layout.mjs         #   L0 物理工作区布局门禁
│  ├─ check-style-tokens.mjs   #   设计令牌样式门禁
│  ├─ check-build-assets.mjs   #   静态构建资产物理一致性门禁
│  └─ check-http-timeout.mjs   #   HTTP 请求超时保护门禁
├─ linter/                     # 自定义代码风格与安全规则
│  ├─ eslint-local-rules.mjs
│  └─ eslint-local-rules.test.mjs
├─ upstream/                   # 上游开源代码审计与同步
│  └─ audit-upstream.mjs
├─ parity/                     # 跨端一致性看守
│  └─ update-source-parity.test.mjs
├─ runner/                     # 本地极速调试启动器
│  ├─ dev-server.mjs           #   核心调度器（状态机+策略+健康探测）
│  └─ dev.bat                  #   工具链内快捷入口
└─ skills/                     # Antigravity Agent 本地技能
   └─ mediary-scout/
```

同步更新引用位置：
1. `package.json` 中的各 `gate:*` 及 `upstream:*` 脚本指向新路径。
2. `eslint.config.mjs` 中的 `import localRules` 路径。
3. `apps/web/tests/style-tokens-gate.test.ts` 中的脚本路径。

### 4.2 本地极速调试启动器实现
1. 编写 [`tools/runner/dev-server.mjs`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/runner/dev-server.mjs)：
   - 实现增量编译检测（mtime 检查）；
   - 实现端口侦听探测与进程树强制清理；
   - 实现环境参数自动注入（真 TMDB + 115 + PanSou + 单用户 + SQLite 挂载）；
   - 实现 `/api/health` 轮询看门狗与自动打开浏览器功能；
   - 支持 `--port <n>`、`--prod`、`--demo`、`--stop`、`--status` 等完整操作。
2. 在仓库根目录建立 [`dev.bat`](file:///e:/WorkProject/Node/_Project/mediary-scout/dev.bat)：
   - 包装对 `node tools/runner/dev-server.mjs %*` 的调用，支持在 Windows 资源管理器直接双击，或在 CMD/PowerShell 运行 `dev`。

### 4.3 其它文件夹平铺问题结论与建议
1. **`apps/web/lib/`（161 个文件）**：
   - 包含 47 个历史兼容 Facade、84 个单测及 30 个通用模块。在当前阶段，其 Facade 作为 Next.js WebHost 的平稳运行垫层起着核心隔离作用。
   - 建议在后续重构迭代中，将 84 个单测文件按所属业务迁移至 `features/<feature>/` 内，最后清理裸 Facade。当前阶段保持其平稳，避免破坏已有 1,750 个前端单测的相对 import 解析。
2. **`scripts/`（12 个文件）**：
   - 包含运维、数据库迁移及本地脚本。在完成 `tools/runner` 后，Windows 本地启动不再依赖 `scripts/run-local-real.sh`。后续可归纳为 `scripts/ops/`、`scripts/db/`。

---

## 五、验证标准

1. **门禁与测试 100% 通过**：
   - `npm run gate` 退出码为 0（Layout / Deps / Style / Assets / Timeout / ESLint / Typecheck 全绿）。
   - `npx vitest run tools` 校验通过。
2. **极速启动实测验证**：
   - 执行 `dev.bat --status` 正确探测服务状态。
   - 执行 `dev.bat` 秒级完成预检并启动 Next.js 调试服务。
   - 执行 `dev.bat --stop` 彻底释放端口，0 僵尸残留。
