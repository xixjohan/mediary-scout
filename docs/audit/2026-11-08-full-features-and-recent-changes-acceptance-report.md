# 巡影 (Mediary Scout) 全功能与近期改动全链路实机验收报告

> **环境验证说明**：本次验收严格遵循工程规范与 [`AGENTS.md`](file:///e:/WorkProject/Node/_Project/mediary-scout/AGENTS.md) 部署双轨制。通过内置真实浏览器探针（Chrome DevTools MCP）连接远程 Linux 极速开发实例（端口 `3020`，生产环境端口 `3000` 全程零影响），对近期落地的全部新功能及所有未提交改动进行了端到端全链路实机走查与截图存证。

---

## 一、验收结果概览看板

| 序号 | 验证模块与功能点 | 预期规范与核心痛点 | 实机验证表现 | 结果 |
| :---: | :--- | :--- | :--- | :---: |
| 1 | **网盘下载与转存统一模态框** | 原“新建离线下载”改版为“下载 / 转存”，支持磁力、直链与 115 / 夸克分享链接混合粘贴，自动提取提取码并拆解多任务卡片 | 成功混合识别 Magnet 与 115 分享链接（含提取码），自动拆解为 `[云端离线]` 与 `[115网盘转存]` 任务卡片，底部按钮联动计数 `(2 条)` | **PASS** |
| 2 | **网盘目录可视化选择器** | 告别晦涩 CID / FID 手动输入，支持树形目录多级穿透展开、动态加载与绝对路径自动反算回填 | 成功加载 115 真实目录树，穿透选中 `/不存在的罪人 (2026) {tmdb-1283515}` 后路径精确回填至表单 | **PASS** |
| 3 | **多网盘能力矩阵自适应** | 夸克网盘激活「网盘分享秒级转存」能力，不支持 BT 离线时优雅置灰并给予告警提示 | 切换至夸克工作区后，提示 `✓ 该网盘支持： 网盘分享秒级转存`，种子上传按钮优雅禁用并呈现友好提示 | **PASS** |
| 4 | **长剧集/千集容器封顶治理** | 动漫与剧集展开缺集网格时，限制最大高度，防止页面无限撑开与视口失控 | `.hub-episode-grid` 计算样式严格锁定为 `max-height: 400px; overflow-y: auto`，附带 100 集分片分页与「只看缺集」筛选 | **PASS** |
| 5 | **设置页「更新」标签即时渲染** | 解决更新 Tab 异步延迟挂载导致的闪烁与抖动，保证首屏同构即时水合 | 「更新」选项卡首屏与网盘、资源、获取偏好、巡检、账号、远程访问等 6 大 Tab 同步就绪，无迟滞与跳跃 | **PASS** |
| 6 | **侧边栏网盘选择器重构** | 替换原生字符 `v`，统一采用 Lucide Chevron 图标与全局设计令牌，消除视觉色差与菜单点击抖动 | 采用 SVG 矢量图标 `lucide-chevron-down`，网盘品牌 SVG 标志、字阶与圆角规范对齐，状态保持稳定 | **PASS** |
| 7 | **STRM 任务中心与层级中继** | STRM 任务创建与编辑弹窗支持网盘目录可视化选择，302 直连中继与秒级热重写 | 成功唤起新建 STRM 任务弹窗，内嵌可视化网盘目录选择器，支持从根目录多级深入选择目标媒体文件夹 | **PASS** |
| 8 | **订阅配额防浪费四大机制** | 彻底治理合集大包滥下、无截止线无限洗版、离散下发与配额耗尽等 6 大漏洞 | 落地大包单集裁决器、画质截止线控制、双轨配额预算池与假种排毒，通过全套独立单元测试 | **PASS** |
| 9 | **全站控制台与架构质量门禁** | 0 运行时错误、0 水合不匹配、0 凭据泄漏、24 项全自动化架构质量门禁通过 | 控制台无任何 Exception/Error，`npm run gate` 24/24 PASS，`lint` 与 `typecheck` 均为 0 错误 | **PASS** |

---

## 二、真实浏览器实机走查图文存证

### 1. 下载 / 转存统一入库模态框与可视化路径选择
- **实测场景**：点击入库模态框中的「浏览网盘目录」，系统动态加载 115 真实网盘目录树；支持多层级进入并一键选中。输入框内混合粘贴磁力链接与带有提取码的 115 分享链接，系统毫秒级解析出提取码 `6666`，并拆解为离线与转存两个子任务，动态响应提交按钮。
- **实机截图存证**：[`docs/screenshots/2026-11-08-ingest-folder-picker-and-mixed-tasks.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-ingest-folder-picker-and-mixed-tasks.png)

---

### 2. 多网盘协议驱动能力矩阵与夸克自适应
- **实测场景**：通过顶部工作区切换器切换到夸克网盘，模态框根据网盘驱动能力矩阵自动激活「网盘分享秒级转存」，并将夸克不支持的「BT 种子上传」按钮优雅置灰且提示原因，避免用户盲目提交导致失败。
- **实机截图存证**：[`docs/screenshots/2026-11-08-ingest-quark-adaptive-capability.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-ingest-quark-adaptive-capability.png)

---

### 3. 长篇动漫/剧集网格容器高度封顶与分片滚动
- **实测场景**：打开《名侦探柯南》超千集详情页，点击展开第 2 季（1555 集），容器高度被精确约束在 `max-height: 400px` 内，内部生成原生流畅滚动条，并搭配「缺集 49/1554/1555」与百集分片选择器，告别千集撑爆视口的体验。
- **实机截图存证**：[`docs/screenshots/2026-11-08-show-episodes-bounded-height.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-show-episodes-bounded-height.png)

---

### 4. 系统设置页面选项卡首屏即时水合
- **实测场景**：进入 `/settings` 系统设置页面，导航栏上的「更新」选项卡在 SSR 首屏即与网盘、资源、获取偏好、巡检、账号、远程访问 6 个 Tab 保持完全同构渲染，彻底消除了客户端异步挂载造成的跳跃闪烁。
- **实机截图存证**：[`docs/screenshots/2026-11-08-settings-tabs-instant-render.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-settings-tabs-instant-render.png)

---

### 5. 侧边栏网盘选择器样式与 Lucide 矢量图标重构
- **实测场景**：侧边栏顶部的网盘工作区切换器淘汰了原本粗糙的字符 `v`，接入标准的 Lucide `ChevronDown` SVG 矢量图标（`ws-caret`），微调了内边距与浮层悬浮效果，与全局设计令牌体系深度融合。
- **实机截图存证**：[`docs/screenshots/2026-11-08-sidebar-drive-switcher-optimized.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-sidebar-drive-switcher-optimized.png)

---

### 6. STRM 任务中心概览与可视化目录选择
- **实测场景**：访问 `/storage/strm` 任务中心，管理页面流畅加载。点击「新建 STRM 任务」弹出创建模态框，点击「可视化选择网盘目录」可无缝打开多级远程目录树，支持层级穿透与绝对路径自动计算回填。
- **实机截图存证**：
  - STRM 任务中心概览：[`docs/screenshots/2026-11-08-storage-strm-overview.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-storage-strm-overview.png)
  - STRM 任务新建弹窗：[`docs/screenshots/2026-11-08-storage-strm-create-task-modal.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-storage-strm-create-task-modal.png)
  - STRM 远程目录选择器：[`docs/screenshots/2026-11-08-storage-strm-remote-folder-picker.png`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/screenshots/2026-11-08-storage-strm-remote-folder-picker.png)

---

## 三、订阅下载配额防浪费体系落地成果

针对 115、夸克等网盘每日离线配额稀缺的痛点，本次研发构建了完整的防浪费治理体系，包含 4 大核心引擎：

### 1. 核心模块与单元测试覆盖
1. **大包 vs 单集智能裁决器 (`pack-episode-arbitrator.ts`)**
   - 源码：[`packages/workflow/src/execution/pack-episode-arbitrator.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/pack-episode-arbitrator.ts)
   - 单元测试：[`packages/workflow/src/execution/pack-episode-arbitrator.test.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/pack-episode-arbitrator.test.ts) (7 项用例全部通过)
2. **画质截止线与洗版控制 (`subscription-policy.ts`)**
   - 源码：[`packages/workflow/src/execution/subscription-policy.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts)
   - 单元测试：[`packages/workflow/tests/execution/subscription-policy.test.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/tests/execution/subscription-policy.test.ts) (39 项用例全部通过)
3. **双轨配额预算池与低水位熔断器 (`quota-budget-pool.ts`)**
   - 源码：[`packages/workflow/src/execution/quota-budget-pool.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/quota-budget-pool.ts)
   - 单元测试：[`packages/workflow/src/execution/quota-budget-pool.test.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/quota-budget-pool.test.ts) (8 项用例全部通过)
4. **假种排毒与发布评分加权 (`deterministic-selector.ts`)**
   - 源码：[`packages/workflow/src/acquisition-v2/deterministic-selector.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/deterministic-selector.ts)
   - 单元测试：[`packages/workflow/tests/acquisition-v2/deterministic-selector.test.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/tests/acquisition-v2/deterministic-selector.test.ts) (6 项用例全部通过)

---

## 四、架构门禁与代码质量指标

执行全量门禁流水线 `npm run gate`，质检结果如下：

```
> gate
> npm run gate:security && npm run gate:db-parity && npm run gate:client-filtering && npm run gate:limits && npm run gate:parity && npm run gate:blocking-routes && npm run gate:hydration && npm run gate:suspense && npm run gate:modals && npm run gate:contracts && npm run gate:layout && npm run gate:deps && npm run gate:server-actions && npm run gate:acquisition && npm run gate:episodes && npm run gate:inspection && npm run gate:strm && npm run gate:post-ingest && npm run gate:catalog && npm run gate:facades && npm run gate:style && npm run gate:assets && npm run gate:http-timeout && npm run lint && npm run typecheck

✔ [Security Gate] 全仓库凭据安全与脱敏门禁质检通过：0 项违规
✔ [DB Parity Gate] 数据库路径单源性规范一致，测试环境严格内存隔离
✔ [Client Filtering Gate] 客户端即时筛选通过，防 N+1 陷阱通过
✔ [Code Limits Gate] 741 个源码文件全部符合体积行数棘轮约束
✔ [Parity Gate] 前后端 API 契约与孤儿路由门禁通过 (0 孤儿路由, 0 错位深埋)
✔ [Blocking Routes Gate] 14 个路由文件与 8 个外壳组件 0 项违规
✔ [Hydration Safety Gate] 489 个前端组件 0 项水合安全违规
✔ [Suspense Gate] 13 个页面入口纯静态骨架，PPR 空洞契约一致
✔ [Modals Gate] 179 个前端组件弹窗 100% createPortal 挂载，0 阻塞
✔ [Contracts Gate] API 契约与时间线字段 100% 对齐，0 幽灵属性访问
✔ [Layout Gate] L0 布局检查通过
✔ [Dependency Cruiser Gate] 0 dependency violations found (1398 模块, 4130 依赖)
✔ [Server Actions Gate] 0 非法 'use server' 导出或 Edge 运行时泄漏
✔ [Acquisition Gate] 反瀑布流检测通过、死信节点记忆就绪、核心域符号 100% 绑定
✔ [Episode Preservation Gate] 全链路剧集状态防抹除就绪、双模仓储对齐
✔ [Untracked Inspection Gate] 未追踪作品快照与探活门禁全部通过
✔ [STRM Gate] 全层级递归扫描、多级目录镜像、双模代理中继全部通过
✔ [Post-Ingest Gate] 全自动闭环架构合规通过
✔ [Catalog Discovery Gate] 影视资源库全量发现门禁通过
✔ [Facades Gate] 门面与契约物理一致性通过 (685 模块, 0 悬空引用)
✔ [Style Tokens Gate] 124 个设计令牌，685 前端组件，0 未定义变量引用
✔ [Build Assets Gate] 静态资产物理一致性校验通过 (34 分块, 0 悬空引用)
✔ [HTTP Timeout Gate] 218 模块中 20 处外部 fetch 调用 100% 具备超时保护
✔ [ESLint] 0 warnings, 0 errors
✔ [TypeScript] 0 type errors (根目录与 apps/web 双工程完全通过)
```

---

## 五、验收结论

本次涉及的 **UI 防抖与侧边栏选择器重构**、**设置页更新选项卡即时渲染**、**千集网格容器高度封顶**、**可视化网盘目录树与下载/转存混合入库**、**STRM 远程目录选择器**、以及**订阅配额防浪费四大优化机制** 均已全部高质量交付并完成实机与单元测试验证。

开发环境容器服务 `mediary-dev:3020` 运行稳健，生产容器 `mediary:3000` 全程受保护且零停机，各项功能表现均符合设计预期。
