# 上游功能复用实施方案与技术落地方案

## 一、复用范围与目标

根据上游提交审计报告与架构兼容性评审，本期复用聚焦在**高价值、低风险、接口完全解耦**的网盘适配与资源搜索适配特性：

1. **UC 网盘完整接入**（支持 UC 网盘分享链接解析、转存执行、CAS 扫码登录与 Cookie 接入）；
2. **光鸭云盘 App 扫码登录**（基于 OAuth Device Code 设备码流程的 FSM 状态机登录）；
3. **海搜（Haisou）官方 API 搜索源**（独立 SearchProvider 策略驱动，支持多网盘平台过滤）；
4. **扫码组件卸载清理与健壮性加固**（115 / 天翼 / 123 扫码卸载清理防泄露与友好错误渲染）。

> [!NOTE]
> **关于 MultiDriveStorageV2 的边界说明**：
> 上游 PR #346 引入的 MultiDriveStorageV2 深度绑定了 PostgreSQL 引擎与复杂的多盘抢占逻辑，严重违背本仓库已完成的**纯 SQLite 单文件治理**规范。因此本期不予搬运其引擎修改，后续若需容量感知，将在纯 SQLite 架构内独立封装轻量驱动。

---

## 二、架构设计与关键改动清单

### 1. UC 网盘接入（参数化适配器模式）
- **内核参数化 (`CloudDriveProfile`)**：
  在 `packages/workflow/src/quark-cookie-client.ts` 与 `quark-storage-executor.ts` 中，通过 `CloudDriveProfile` 结构将域名、CAS Host、Client ID、二维码路径、请求头及错误前缀收敛为配置驱动，一套逻辑同时服务夸克与 UC。
- **UC 特有差异处理**：
  - 处理 UC 特有的同名文件冲突错误码 `23008`；
  - 针对 UC 目录新建后 ~900ms 的最终一致性延迟，内置重试探测机制。
- **CAS 扫码与 Cookie 连接**：
  - 前端抽取 `CloudFamilyQrConnect` 与 `CloudFamilyCookieConnect` 组件，同时兼容 Quark 与 UC；
  - 后端提供统一的 `createFamilyQrRoutes` 路由工厂，暴露 `/api/uc/qrcode/*` 接口。
- **品牌与样式门禁**：
  - 引入 `apps/web/public/brands/uc.svg`；
  - 网盘 Tab 样式严格采用设计令牌（`var(--mt-token-*)`），确保通过 `check-style-tokens.mjs`。

### 2. 光鸭云盘 App 扫码登录（有限状态机 FSM）
- **状态流转设计**：
  - `guangya-device-login.ts`：实现 `requestDeviceCode()` -> 状态轮询 (`pollDeviceCodeStatus`) -> `exchangeDeviceToken()`。
  - `apps/web/app/api/guangya/qrcode/*` 路由暴露二维码生成与状态轮询。
  - 前端 `GuangyaQrConnect` 组件提供扫码、倒计时与自动绑定。

### 3. 海搜官方 API 搜索源（策略模式）
- **接口契约**：
  - 实现 `packages/workflow/src/haisou-provider.ts`，实现与其他搜索源统一的输出契约；
  - 显式传递 `platforms` 参数（`quark,uc,115,123,tianyi`），避免过滤掉小平台分享链接。
- **前端配置表单**：
  - 设置页增加海搜 API Token 配置表单 `HaisouConfigForm`；
  - 状态探活接口与 `service-status.ts` 集成。

### 4. 扫码组件卸载清理
- 在 `pan115-qr-connect`、`tianyi-qr-connect`、`pan123-qr-connect` 中：
  - 组件 unmount 时递增 generation 取消后续轮询；
  - 统一错误文案展示：`error instanceof Error ? error.message : "无法获取二维码"`。

---

## 三、质量保证与防回归策略

1. **单元测试矩阵**：
   - `packages/workflow/tests/quark-cookie-client.test.ts`（覆盖 UC 鉴权与转存）；
   - `packages/workflow/tests/quark-qrcode-login.test.ts`（覆盖 UC CAS 扫码全状态机）；
   - `packages/workflow/tests/guangya-device-login.test.ts`（覆盖光鸭设备码状态机与重试）；
   - `packages/workflow/tests/haisou-provider.test.ts`（覆盖海搜 API 调用、限流与平台解析）；
   - `apps/web/app/api/uc/qrcode/image/route.test.ts`（覆盖 UC 扫码路由）。
2. **样式门禁**：
   - 运行 `node scripts/check-style-tokens.mjs` 校验所有新增及修改的前端组件样式；
3. **架构与布局门禁**：
   - 运行 `npm run gate` 验证 0 ESLint 警告、0 TypeScript 报错、依赖拓扑无环。

---

## 四、落地实施与验证记录

1. **测试用例全量通过**：
   - 运行受影响模块单元测试：23 个测试套件、375 个测试用例全部一次性通过（`375 passed (375)`）。
2. **样式门禁通过**：
   - `node scripts/check-style-tokens.mjs`：89 个设计令牌校验通过，0 处未定义变量引用，网盘与表单组件 100% 令牌化。
3. **全面质量门禁通过**：
   - `npm run gate`：L0 布局检查、depcruise 依赖拓扑校验、样式令牌门禁、ESLint 严格质检（0 warnings）、TypeScript 全量类型检查（0 errors）全部通过。
4. **前端编译与路由验证**：
   - `npm run build:web`：73 个 App 路由（含新增的 UC 扫码与光鸭扫码路由）成功编译与优化。
5. **真实浏览器端到端交互验证（Playwright Headless）**：
   - 设置页「选择网盘品牌」瓦片完整渲染 6 大品牌（115、夸克、UC、光鸭、天翼、123）；
   - 点击 UC 网盘瓦片成功展开扫码区域与手动 Cookie 折叠回退；点击「生成二维码」成功响应并进入轮询状态；
   - 点击光鸭云盘瓦片成功展示 App 扫码登录与手动 Token 折叠回退；
   - 资源提供商区域成功挂载「海搜 (haisou)」配置卡片与「每日 100 次免费」状态胶囊；
   - 浏览器控制台在全交互流程中保持 0 错误（Console errors: `[]`）。
6. **固化自动化审计工具**：
   - 固化 `scripts/audit-upstream.mjs`，可通过 `npm run upstream:audit` 或 `npm run upstream:fetch-audit` 一键获取上游最新变更并生成风险评估报告。
