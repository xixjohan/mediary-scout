# Next.js 16 PPR 动态流式空洞与 connection() 确定性预渲染架构设计与质量门禁规范

> **文档版本**: 1.0.0  
> **适用范围**: `apps/web/app/**/*.tsx`, `tools/gates/check-suspense-fallbacks.mjs`  
> **关联协议**: React 19 Server Components / Next.js 16.4+ PPR (Partial Prerendering) / Turbopack Cache Components  

---

## 1. 故障现场与根本原因调研 (Problem & Root Cause Deep Dive)

### 1.1 报错特征
在 Next.js 16.4.3 (Turbopack) 开启实验性 `cacheComponents: true` 与 `partialPrefetching: true` (PPR) 的环境下，访问主路由 `/` 或部分受保护动态页面时，控制台抛出阻塞性路由致命预渲染异常：

```
## Error Type
Blocking Route

## Error Message
Route "/": Next.js encountered the unstable value `new Date()` while prerendering.

This value can change between renders, so it must be either prerendered or computed later.

Ways to fix this:
  - [dynamic] Render at request time by adding a dynamic data access (e.g. `await connection()`) before this call
  - [cache] Prerender and cache the value with `"use cache"`
  - [client] Render the value on the client with `"use client"`
  - [measure] If the value is for telemetry, use a timing API such as `performance.now()`

Learn more: https://nextjs.org/docs/messages/blocking-prerender-current-time

    at resolveSessionAccountId (features\auth\application\account-service.ts:151:55)
    at readSessionAccountId (platform\next-context\request-account.ts:26:12)
    at resolveSingleUserCurrentAccount (platform\next-context\request-account.ts:61:28)
    at getRegisteredDriveCount (lib\workflow-runtime.ts:501:68)
    at HomeSurface (app\page.tsx:159:22)
    at HomeView (app\page.tsx:73:7)
    at Page (app\page.tsx:50:7)
```

### 1.2 故障链路剖析
1. **PPR 双阶段渲染模型**：
   - **阶段一（静态预渲染 / Prerender Pass）**：Next.js 构建或开发服务器在收到请求时，首先尝试静态编译渲染整个组件树。所有位于 `<Suspense fallback={<Shell />}>` 外层以及 fallback 本身必须是 100% 纯静态确定的。
   - **阶段二（动态请求流式空洞 / Dynamic Hole Streaming）**：位于 `<Suspense>` 内部的子组件被视为主内容空洞。Next.js 允许该空洞在请求到达时按需执行并流式推送到客户端。
2. **预渲染探针击穿与未标记动态空洞**：
   - 在 Next.js 16 的执行模型中，当进入 `<Suspense>` 内部执行异步服务端组件（如 `HomeSurface`）时，Next.js 并不会无条件将其视作动态；它会继续在静态探针模式下执行该异步组件，直到该组件通过标准原语显式声明「退出静态预渲染（Dynamic Bailout）」。
   - 虽然深层的 `SearchResults` 与 `LibrarySurface` 组件内部声明了 `await connection()`，但作为直接被 `<Suspense>` 包裹的父级异步组件 `HomeSurface`，在首行并未声明 `await connection()`。
   - `HomeSurface` 在第 159 行直接调用了 `await getRegisteredDriveCount()`。
   - `getRegisteredDriveCount()` 级联调用：
     `getCurrentAccountId()` $\to$ `resolveSingleUserCurrentAccount()` $\to$ `readSessionAccountId(sessionCookie)` $\to$ `resolveSessionAccountId(signedCookie)`.
   - `resolveSessionAccountId` 为校验 Session 寿命调用了非确定性 API：`isSessionExpired(session.expiresAt, new Date().toISOString())`。
   - 由于此时执行上下文仍处于 Next.js 的静态预渲染探测期，Next.js 运行时拦截到非幂等的 `new Date()` 调用，随即触发致命中断，拒绝静态预渲染产物并抛出 `Blocking Route` 异常。

---

## 2. 业界主流方案调研与对比 (Industry Benchmarks & Comparative Analysis)

| 方案 | 核心机制 | 优点 | 缺点 | 适用性与结论 |
| :--- | :--- | :--- | :--- | :--- |
| **方案 A：屏蔽时间调用（伪确定性时间基准）** | 在预渲染期用固定时间戳（如 `1970-01-01`）伪造 `new Date()` | 避开 Next.js 的拦截 | 严重破坏 Session / Token 鉴权逻辑，导致安全过期判断在构建期和请求期产生语义分裂 | ❌ **坚决否定** |
| **方案 B：将整个组件降级为客户端组件 (`"use client"`)** | 放弃服务端组件与 SSR，全部转为客户端 `fetch` | 客户端拥有原生 DOM 和时间环境 | 丢失 PPR 首屏极速直出优势，造成海报与排版巨幅水合跳动，违背巡影 L0/L1 性能规范 | ❌ **违背架构目标** |
| **方案 C：Next.js 15/16 官方标准 `await connection()` 动态空洞声明** | 在每个由 `<Suspense>` 直接挂载的异步页面 Surface 组件首行调用 `await connection()` | 1. 严格遵循官方 PPR 规范；<br>2. 静态 Shell 正常预渲染；<br>3. 动态组件在请求到达时以流式推送到客户端；<br>4. 内部允许自由调用 `cookies()`、`headers()`、`new Date()` 与 SQLite。 | 需要确保所有异步页面 Surface 组件无一遗漏 | ✅ **业界主流最佳实践（采纳）** |

---

## 3. 基础设施复用与架构解耦

### 3.1 Next.js 内置原语复用
Next.js 15+ 官方在 `next/server` 中提供了 `connection()` 异步函数：
```ts
import { connection } from "next/server";

async function PageSurface(...) {
  await connection();
  // 从此处开始，所有操作均安全处于请求期动态空洞中
}
```
当 Next.js 在静态预渲染期执行到 `await connection()` 时，它会主动抛出内部可恢复控制流信号 `throwToInterruptStaticGeneration`，通知外层 `<Suspense>` 停止静态预计算，将该空洞完全推迟至请求期（Request Time）推流，从而允许后续所有动态数据读取（包括 `new Date()`、会话校验、网盘连接等）安全运行。

### 3.2 现有门禁引擎复用
系统现存以下两道 AST 静态扫描门禁：
- [`tools/gates/check-blocking-routes.mjs`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-blocking-routes.mjs)：负责检查页面根导出禁止 async、动态参数禁止在 default 顶层直接 await、AuthGuard 包裹性。
- [`tools/gates/check-suspense-fallbacks.mjs`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-suspense-fallbacks.mjs)：负责检查 Suspense Fallback 纯静态骨架性、禁止动态 Loader 渗透。

**复用与升级策略**：
在 `tools/gates/check-suspense-fallbacks.mjs` 中正式启用 **规则 4：Dynamic-Hole-Connection-Required**：
利用 TypeScript AST 遍历每个页面文件，提取所有被 `<Suspense>` 直接包裹的异步组件声明。断言该异步组件的函数体前部必须显式包含 `await connection()` 调用。如有遗漏，门禁在 CI 与构建前毫秒级报出违规代码行号，永久切断同类回归风险。

---

## 4. 全量受影响页面清单与修复方案

经全工程 AST 扫描，以下 9 个受保护页面的直接异步 Surface 组件需统一补齐首行 `await connection()`：

1. **首页** [`apps/web/app/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/page.tsx)：
   - 组件：`HomeSurface`
2. **多工作区主页** [`apps/web/app/w/[storageId]/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/w/[storageId]/page.tsx)：
   - 组件：`ValidatedWorkspaceHome`
3. **活动中心** [`apps/web/app/activity/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/activity/page.tsx)：
   - 组件：`ActivitySurface`
4. **AI 助手** [`apps/web/app/chat/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/chat/page.tsx)：
   - 组件：`ChatSurface`
5. **通知中心** [`apps/web/app/notifications/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/notifications/page.tsx)：
   - 组件：`NotificationsSurface`
6. **全局设置页** [`apps/web/app/settings/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/settings/page.tsx)：
   - 组件：`SettingsSidebar`
7. **媒体服务器设置** [`apps/web/app/settings/mediaserver/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/settings/mediaserver/page.tsx)：
   - 组件：`MediaServerSettingsSurface`
8. **扩展中心设置** [`apps/web/app/settings/extensions/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/settings/extensions/page.tsx)：
   - 组件：`ExtensionsSettingsSurface`
9. **网盘与 STRM 计划**：
   - [`apps/web/app/storage/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/storage/page.tsx)：`StorageSurface`
   - [`apps/web/app/storage/strm/page.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/storage/strm/page.tsx)：`StrmSurface`

*(注：`ShowContent`、`ForeignWorkReview`、`NotificationFeed` 以及 settings 下各子 section 组件此前已遵守此规范并声明了 `await connection()`，保持现状即可)*

---

## 5. 质量门禁与自动化验证

1. **AST 静态门禁**：
   - 在 `tools/gates/check-suspense-fallbacks.mjs` 中实现对所有 `page.tsx` 内被 `<Suspense>` 挂载的异步组件的 `await connection()` 静态检测；
   - 增加单元测试 `tools/gates/check-suspense-fallbacks.test.mjs`，包含：
     - 正向测试：包含 `await connection()` 的异步 Surface 组件通过门禁；
     - 负向测试：缺少 `await connection()` 的异步 Surface 组件被拦截并报错；
     - 豁免测试：客户端组件或纯同步组件不受此约束。
2. **全量门禁流水线**：
   - 执行 `npm run gate`，确保全量 20 项门禁及类型检查 100% 绿色通过。
3. **实机端到端验收走查**：
   - 驱动内置 Playwright 浏览器，对修复后的页面进行深度导航与长效静默监听，断言 0 控制台报错、0 预渲染阻塞中断。
