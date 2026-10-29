# 活动页面任务列表数据不可见问题调研与架构优化方案

## 1. 问题背景与现象

### 1.1 问题现象
用户在智能对话助理（Chat Copilot）或后台状态查询中，清晰看到当前有且仅有 1 个正在执行的任务：
- **任务名称**：🌲 《荒野丛林》（tmdbId: 791523）
- **任务类型**：`manual_import`（手动入库）
- **当前状态**：⏳ 正在执行（`status: "running"`，多次被恢复并认领）

然而，当用户点击导航栏进入「活动」页面（`/activity`，即 `http://<host>:3001/activity`）时：
- 页面显示：“当前没有正在处理的任务。”
- 排队中、获取中列表全部为空，正在运行的《荒野丛林》在活动面板中**完全不可见（Invisible）**。

---

## 2. 根因深度剖析（Root Cause Analysis）

经过系统全链路追踪（从前端组件 `ActivityFeed`、Next.js 路由 `/api/activity`、业务视图层 `getActivityView`、数据仓储层 `SqliteWorkflowRepository` 到任务触发接口 `/api/titles/import` 与 `/api/titles/resources`），定位到以下两大核心根因：

### 2.1 根因一：视图层作用域隔离的“视界盲区”（View Scope Blindspot）
- **机制原理**：
  巡影采用了多网盘工作区树状模型（Tree Model），用户每个网盘有独立工作区（例如 `cs_quark_AAQ69oQ5Vj9Myt5R0uGt7omX`）。
  当用户进入 `/activity` 页面时，系统通过 `resolveGlobalWorkspace` 自动解析出当前激活的网盘 ID（即使 URL 无 `?w=`，系统也会自动回落到主盘 `cs_quark_...` 作为默认工作区）。
- **过滤陷阱**：
  `/api/activity` 将解析后的作用域 `{ accountId: "acct_default", connectedStorageId: "cs_quark_..." }` 传递给 `getActivityView`。
  底层 `SqliteWorkflowRepository.listActiveWorkflowRuns(scope)` 在执行 `scopeMatches` 校验时：
  ```typescript
  if (scope.connectedStorageId != null && (rowStorageId ?? null) !== scope.connectedStorageId) {
    return false; // 严格匹配：如果任务无盘属性（null），直接过滤剔除！
  }
  ```
  因为历史任务或未定盘任务的 `connected_storage_id` 在 SQLite 数据库中为 `__unscoped__`（解析为 `null`），只要用户处在任何一个具体盘的工作区下，该任务就会被**无情剔除**！
- **为什么 Chat 助理能看到**：
  Chat 对话助理调度 `executeQueryStatus(accountId, storageId)` 时，若当前无明确网盘传参，传入的 `connectedStorageId` 为 `null`，此时 `scopeMatches` 不执行网盘过滤，因而返回了账号下全部运行任务。

### 2.2 根因二：详情页资源检索与手动入库链路的存储上下文丢失（Context Drop）
- **上下文断流**：
  用户在影视详情页（`/show/791523`）搜索资源并点击候选进行“手动入库”：
  1. 前端 `title-resource-panel.tsx` 发起 `POST /api/titles/resources` 时，未携带 `storageId`；
  2. 服务端 `resolveTitleContext` 发现该影片尚未被追踪（Untracked），硬编码回落为 `connectedStorageId: null`；
  3. 用户点击入库发起 `POST /api/titles/import`，接口直接提取前一步快照中的 `record.connectedStorageId`（即 `null`），导致新生成的 `manual_import` 工作流的 `connected_storage_id` 字段落库为 `__unscoped__`。
- **恶性循环**：
  未绑定网盘的任务虽然由工作线程（worker）正常认领转存到了默认网盘，但在所有网盘视图中均判定为“非本盘任务”，沦为**幽灵任务**。

---

## 3. 解决方案设计与设计模式应用

针对上述问题，我们采用**分层防御 + 设计模式**彻底根治：

```
                ┌─────────────────────────────────────────────────────┐
                │               用户界面 (UI / 交互层)                │
                └─────────────────────────┬───────────────────────────┘
                                          │
                 ┌────────────────────────┴──────────────────────────┐
                 ▼                                                   ▼
       【写入侧：上下文传递与补全】                         【读取侧：作用域阶梯合并】
  TitleResourcePanel / ImportRoute                      getActivityView (Activity)
                 │                                                   │
  ┌──────────────┴──────────────┐                     ┌──────────────┴──────────────┐
  │ 适配器与回落策略             │                     │ 合成模式 (Composite Scope)   │
  │ (Fallback Context Strategy) │                     │ · 查询目标盘专属任务        │
  │ 未绑盘影片入库时，自动继承    │                     │ · 并行合并不定盘(Unscoped)   │
  │ 用户激活/主网盘上下文，避免   │                     │   通用任务，消除视界盲区    │
  │ 生成 __unscoped__ 孤儿任务   │                     │ · 结果严格排重与状态对齐    │
  └──────────────┬──────────────┘                     └──────────────┬──────────────┘
                 │                                                   │
                 └────────────────────────┬──────────────────────────┘
                                          ▼
                               ┌─────────────────────┐
                               │ SQLite Workflow DB  │
                               └─────────────────────┘
```

### 3.1 方案 A：读取侧合成模式 —— 作用域阶梯合并（Scope Cascading & Merging）
在 `apps/web/lib/activity-view.ts` 中实现合成模式：
- 当用户进入某网盘工作区（`connectedStorageId != null`）查询活动状态时，系统不仅查询该网盘名下的专属任务，**同时级联检索当前账号名下的通用未绑盘任务（`connectedStorageId: null`）**；
- 将专属任务与通用任务通过 `workflowRun.id` 排重聚合；
- 无论是从通用页面触发的任务、历史遗留任务还是未定盘任务，均能在活动面板中 100% 呈现，杜绝幽灵任务。

### 3.2 方案 B：写入侧适配器策略 —— 网盘上下文自动补全（Storage Context Adapter）
- 在 `title-resource-panel.tsx`、`/api/titles/resources` 与 `/api/titles/import` 中建立端到端上下文传递：
  - 前端面板携带当前工作区 `storageId`；
  - 若请求未显式指定（如直接 API 调用或通用搜索），服务端利用 `resolveGlobalWorkspace` 自动解析出用户的默认主盘（Primary Drive）进行上下文补全；
  - 保证每一个入库工作流在落库第一秒起就归属于确切的网盘。

### 3.3 方案 C：既有运行任务数据平滑自愈（Self-Healing Migration）
- 针对当前数据库中正在执行的 `9dbf08a0-9fcc-4637-8efe-190dc0854034`（《荒野丛林》），自动修复其 `connected_storage_id` 为当前网盘 ID，双重保障任务在前端立刻点亮。

---

## 4. 质量门禁与防回归测试

1. **单元测试门禁 (`activity-view.test.ts`)**：
   - 验证 `getActivityView` 在传入具体 `connectedStorageId` 时，能成功合并不定盘（`unscoped`）的运行中任务；
   - 验证专属任务与通用任务的去重逻辑与排序规则。
2. **入库作用域测试 (`import-route.test.ts`)**：
   - 验证无盘状态下手动入库时，自动推导主盘上下文，生成的 `workflow_run` 拥有合法的 `connectedStorageId`。
3. **全局质量门禁**：
   - 保证复杂度不超过 15，单文件不超过 600 行，设计令牌 100% 合规。
