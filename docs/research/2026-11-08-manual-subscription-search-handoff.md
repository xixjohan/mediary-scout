# 订阅手动补搜：排查根因、修复方案与最终真实验收结果

## 1. 核心根因确认 (Root Cause)

前两次真实补搜失败并报出 `WRITE_SCOPE_VIOLATION: unable to verify create directory target fid=...` 的根本原因已彻底查明：

1. **执行器混淆**：
   - 错误字符串 `fid=` 属于夸克存储执行器（`packages/workflow/src/storage/quark-storage-executor.ts`），115 执行器的错误格式使用 `cid=`。
   - 目标 ID 确实属于 115 网盘（`cs_3204551`）绑定的动漫分类目录。但在系统默认账号（`acct_default`）下，夸克存储记录排在首位，因此 `worker-runner-service.ts` 初始化兜底 baseline 依赖时，`storage` 被实例化为了**夸克存储执行器**。

2. **调用参数手误**：
   - 在 `packages/workflow/src/execution/worker.ts` 中，`runQueuedType3Season`（原行 748-750）与 `runQueuedType3Movie`（原行 612-614）在认领任务并解析出 115 专属上下文 `deps` 后，传给底层执行引擎的参数发生了致命手误：
     ```typescript
     // 修复前：传入了 baseline 的夸克 storage，却传入了 115 的 categoryParentId！
     resourceProvider: input.request.resourceProvider,
     storage: input.request.storage,
     model: input.request.model,
     ```
   - 这导致底层执行引擎持着**夸克存储执行器**，试图在 **115 的动漫分类目录**下新建剧集目录。夸克执行器校验发现父目录不在夸克的 `scopeCids` 白名单内，从而抛出了 `WRITE_SCOPE_VIOLATION: unable to verify create directory target fid=...`。
   - 这同时也解释了为什么此前调整 115 驱动优先使用 Cookie 轨未起作用：因为此前任务从未真正调用 115 执行器。

---

## 2. 修复与质量门禁

1. **代码最小修复**：
   - 在 `packages/workflow/src/execution/worker.ts` 中，将 `runQueuedType3Season` 和 `runQueuedType3Movie` 中的存储执行器、资源提供者、语言模型统一切换为通过 `resolveWorkerDeps` 解析出的任务绑定实例：
     ```typescript
     resourceProvider: input.deps.resourceProvider,
     storage: input.deps.storage,
     model: input.deps.model,
     ```
   - 还原了 `packages/workflow/src/storage/pan115-unified-api.ts` 及其测试中关于 `createFolder` 优先走 Cookie 的临时改动，保持既有官方合规 Open API 优先架构。

2. **聚焦测试补充**：
   - 在 `packages/workflow/tests/execution/type3-worker.test.ts` 中新增 2 项聚焦隔离性测试：
     - `isolates storage executor and category parents to the claimed connected storage instead of base deps`：模拟 base storage 设为抛出 `fid=base_trap` 陷阱，断言剧集补搜任务严格走绑定存储（115），绝不调用 base storage。
     - `isolates storage executor and category parents for movie manual search to the claimed connected storage`：断言电影补搜同样满足该隔离性。
   - `type3-worker.test.ts` 全量 60 项测试通过。
   - 包含 `manual-subscription-search.test.ts` 等在内的相关 7 个测试文件、167 项测试全部通过。

3. **质量门禁验证**：
   - `npm run build:workflow` 编译通过。
   - `npm run typecheck` 0 错误通过。
   - `npm run lint` 0 warning 通过。
   - `gate:security`、`gate:server-actions`、`gate:acquisition`、`gate:episodes`、`gate:db-parity` 门禁全部通过。

---

## 3. 真实环境部署与端到端实机复验

1. **开发实例部署**：
   - 部署至隔离开发实例（`mediary-dev`，端口 3020），构建指纹为 `f59bc0cf-dirty-020231`。
   - 健康检查就绪（`/api/health` 200 OK）。
   - 115 Open OAuth 令牌自动保活就绪（`[token-keepalive] refreshed proactively`）。

2. **第 3 次真实补搜执行与结果追踪**：
   - 经用户授权确认，通过内置浏览器在《无职转生》第 1 季页面点击【立即搜索缺失资源】。
   - 任务成功入队并在后台执行（Workflow Run ID: `1aab1910-4b06-4632-b57a-920f690fdaf8`）。
   - **执行过程与日志验证**：
     - 认领任务并绑定 `connected_storage_id: cs_3204551`。
     - 启动 115 执行器（`Pan115UnifiedStorageExecutor`），Open API 端点未开放时平滑降级至 Cookie 轨创建目录。
     - 成功通过 PanSou 检索候选并执行 `transferCandidate`，调用 115 离线下载端点。
     - 115 网盘接口返回真实业务状态：`转存失败:云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！`。
     - 任务正常清理临时 staging 目录，记录 notification 与 memory，正常结束工作流（status: `no_coverage`）。
   - **验证结论**：`WRITE_SCOPE_VIOLATION` 错误彻底消除，网盘隔离逻辑生效，入库链路正常流转并与真实 115 网盘完成交互。
