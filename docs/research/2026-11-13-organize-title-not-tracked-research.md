# 「整理与多版本归档」报 `title not tracked` · 根因与解决方案

> 调研日期：2026-11-13
> 触发场景：网盘管理 → `Anime/凡人修仙传 (2020) {tmdb-106449}` → 点击「整理与多版本归档」
> 代码基线：`39b4d5fa`
> 关联文档：`2026-11-13-strm-ttl-organize-and-multiversion-research.md`

---

## 1. 结论

`title not tracked` 不是权限问题、也不是网盘问题，而是**语义错配**：

> 「整理」被要求以「追踪态（tracked season state）」为前提，而**追踪态来自工作流运行记录**（`workflow_runs`），不是「文件是否存在」。
> 盘里已有的内容（手工上传、旧盘迁移、其他工具落盘）从未跑过本系统的任务，因此永远"未被追踪"，整理入口必然 404。

复现路径完全确定：`apps/web/app/api/titles/organize/route.ts:70`。

---

## 2. 代码路径（逐层可验证）

```
点击「整理与多版本归档」
  → POST /api/titles/organize  { tmdbId, directoryId, seasonNumber? }
  → resolveOrganizeContext()                         route.ts:96
      → resolveOrganizeTarget()                      route.ts:54
          → getWorkflowRepository().listTrackedSeasonStates(accountId)
          → 过滤 state.title.tmdbId === tmdbId
          → matchedStates.length === 0 → 404 "title not tracked"   route.ts:70
```

而 `listTrackedSeasonStates()` 的实现（`persistence/sqlite.ts:1304`）是：

```ts
return this.latestRunPerSeason(this.scopedRunRows({ accountId })).map(...)
```

即：**从运行记录（run rows）反推"追踪了哪些季"**。没有 run → 没有 state → 404。

对照：媒体库扫描（`library-scanner`）只写 `library_*` 表，**不产生 run**；`/api/storage/files/adopt` 才会通过 `adoptExistingMovie` / `adoptExistingTvSeason` 写一条 completed 快照。

**所以同一批文件有两条命运**：
- 走「反推订阅（adopt）」→ 有 run → 可整理；
- 直接扫描入库 → 无 run → 整理 404。

---

## 3. 本质：用「任务历史」充当「媒体身份」

| 整理真正需要的 | 当前实现依赖的 |
| :--- | :--- |
| 这个目录属于哪部作品（tmdbId / 名称 / 年份 / 类型） | 我们是否为它跑过一次任务 |
| 在哪个盘、哪个父目录（storageId / parentId） | 追踪记录里保存的 `connectedStorageId` |
| 季号（TV/Anime） | 追踪记录里的 `season.seasonNumber` |

前两者是**客观事实**（目录名里就写着 `{tmdb-106449}`，盘 ID 就在请求上下文里），后者是**历史痕迹**。用历史痕迹去推断客观事实，就会出现"目录明明已经规范命名，却因为没跑过任务而不能整理"。

---

## 4. 顺带发现的两个隐患（同一处代码）

### 4.1 跨盘错配

`resolveOrganizeTarget` 只按 `accountId` 取追踪态，**不按 storage 过滤**：

```ts
const states = await getWorkflowRepository().listTrackedSeasonStates(input.accountId);
```

若同一部片在 A 盘被追踪过，用户在 B 盘点整理，`target.connectedStorageId` 会是 **A 盘**，随后 `buildAccountContextResolver(accountId, A)` 拿到 A 盘的 storage 执行器，却用 B 盘的 `directoryId` 去 `listChildDirectories` —— 轻则 404/空结果，重则**在错误的盘上创建目录**。

### 4.2 请求体不带 storageId

前端调用（`storage-manager-view.tsx:474`）只发 `{ tmdbId, directoryId, seasonNumber? }`，**没有 storageId**。这意味着服务端即使想"用当前盘兜底"也无从得知——这是自动 adopt 方案必须先补的契约缺口。

---

## 5. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **A. 整理前自动纳入（adopt）** | 未追踪时先调 `adoptExistingMovie/TvSeason` 写快照，再走原整理流程 | 复用现成能力；整理后媒体库/追更立刻可见；语义一致（"盘里已有的内容"） | 会产生追踪记录（可见副作用）；TV 需要逐集快照 | **推荐（需用户确认）** |
| **B. 仅整理不追踪（transient context）** | 用 TMDB 详情临时构造 `MediaTitle`，不写任何追踪态 | 零副作用；纯文件操作 | 整理结果在库里仍不可见（需再扫描）；与现有"整理=库内操作"的语义分叉 | 备选（"仅整理"模式） |
| **C. 只改文案** | 409 + `code=NOT_TRACKED` + 引导"先纳入媒体库" | 改动最小 | 不解决需求，用户仍需两步操作 | 作为兜底 |

**建议组合**：A 为主（弹窗确认"该目录尚未纳入媒体库，是否一并纳入并整理？"），C 作为拒绝时的明确反馈，B 作为高级选项（后续）。

> 关键事实：`/api/storage/files/adopt` **不创建订阅策略、不触发下载**（路由内无 subscription 调用），它只写一条 completed 快照。因此"自动 adopt"不会引发意外追更，副作用仅为"媒体出现在库里"。

---

## 6. 具体方案设计

### 6.1 契约扩展（向后兼容）

```ts
POST /api/titles/organize
{
  tmdbId: number;
  directoryId?: string;
  seasonNumber?: number;
  storageId?: string;          // 新增：当前盘（未追踪时必需）
  category?: "movies" | "tv" | "anime";  // 新增：来自面包屑，决定 type 与父目录
  adoptIfUntracked?: boolean;  // 新增：显式同意"未追踪则先纳入"
}
```

- 缺省（不带 `storageId` / `adoptIfUntracked`）→ 保持现行为，返回 409 + `code=NOT_TRACKED`（不再裸 404）；
- 带 `storageId` 且 `adoptIfUntracked=true` → 先 adopt 再整理；
- `storageId` 必须属于当前账号（见 6.3 越权校验）。

### 6.2 解析策略化（Strategy）

```
OrganizeTargetResolver
  ├─ TrackedTargetResolver        // 现有逻辑：按 tmdbId 找追踪态（加 storage 过滤）
  └─ AdoptThenResolveResolver     // 未命中时：TMDB 详情 → adopt → 复用 Tracked 结果
```

`AdoptThenResolveResolver` 需要：
1. `getMovieDetails(tmdbId)` 或 `getTvDetails(tmdbId)`（`providers/tmdb-provider.ts:278/310`）→ 名称、年份、origin_country；
2. 类型判定：优先 `category`（面包屑 Movies/TV/Anime）；缺省时用 TMDB `media_type`，anime 判定用 `origin_country ∈ {JP,CN}` + `genre 16`（与既有 searchProfile 口径一致）；
3. 列出目录内视频文件（`listTree`）→ 作为 `adoptExisting*` 的 `videoFiles`；
4. 调用 `adoptExistingMovie/TvSeason` 写快照；
5. 重新走 `TrackedTargetResolver`（此时必然命中）。

### 6.3 越权与跨盘校验（必须）

```ts
const storages = await listConnectedStorages(accountId);
if (!storages.some((s) => s.id === body.storageId)) return 403;
```

并在 `TrackedTargetResolver` 里补 `scope = { accountId, connectedStorageId: storageId }`，从根上修掉 4.1 的跨盘错配。

### 6.4 错误语义

| 场景 | 现状 | 目标 |
| :--- | :--- | :--- |
| 未追踪、未同意 adopt | `404 {error:"title not tracked"}` | `409 {code:"NOT_TRACKED", action:"adopt", message:"该目录尚未纳入媒体库，可一并纳入后整理"}` |
| 未追踪、缺 storageId | 同上 | `400 {code:"STORAGE_REQUIRED"}` |
| storageId 不属于当前账号 | 无（会误用别的盘） | `403 {code:"STORAGE_FORBIDDEN"}` |
| TMDB 查不到 | — | `404 {code:"TMDB_NOT_FOUND"}` |
| adopt 成功但整理失败 | — | `200 {status:"adopted_but_not_organized", ...}`（不能让用户误以为整理成功） |

### 6.5 前端交互

点击整理 → 收到 409/`NOT_TRACKED` → 弹确认框（复用现有 modal 体系）：
> 「`凡人修仙传 (2020)` 尚未纳入媒体库。纳入后可正常整理与归档，不会触发下载。是否继续？」
→ 确认后带 `storageId + adoptIfUntracked:true` 重试。

---

## 7. 设计模式落点

| 模式 | 落点 | 解决什么 |
| :--- | :--- | :--- |
| **策略 Strategy** | `OrganizeTargetResolver`（Tracked / AdoptThenResolve） | 把"如何得到整理上下文"从路由里拆出，可测可换 |
| **适配器 Adapter** | `TitleContextAdapter`：TMDB 详情 / 追踪态 / 目录名 → 统一的 `MediaTitle` | 三种来源字段口径不一，统一后才能复用同一套 handler |
| **状态机 State** | `OrganizeJob`：`resolving → adopting → planning → executing → done/failed` | adopt 与整理是两个阶段，失败要能区分"已纳入但未整理" |
| **门面 Facade** | `ensureOrganizableTarget()` 一个入口封装 6.1–6.3 | 路由只做参数校验与响应映射 |

**不建议**：把 adopt 塞进 `MediaOrganizer`（它是纯文件整理器，不该知道追踪态）。

---

## 8. 业界对比

| 产品 | 整理前提 | 差异点 |
| :--- | :--- | :--- |
| **Radarr / Sonarr** | 影片/剧集必须在库中（library）才能 rename | 它们的"库"是**扫描文件系统得到的**，只要文件在、名字能识别，就在库中 |
| **Jellyfin / Emby** | 库扫描即管理，改名不需要"订阅" | 没有"任务历史"概念 |
| **Plex** | 同理，扫描即识别 | — |
| **本项目** | 需要 `workflow_runs` 里存在该季记录 | **把"任务历史"当成了"媒体身份"** |

结论：业界把"文件存在且可识别"作为整理前提；本项目把"跑过任务"作为前提。这不是能力缺失，而是**判定依据选错**。

---

## 9. 可复用资产

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| `adoptExistingMovie` / `adoptExistingTvSeason` | `execution/adopt-existing-media.ts` | 方案 A 的核心，已含 `existing_media_adopted` 事件 |
| `/api/storage/files/adopt` | `app/api/storage/files/adopt/route.ts` | 现成的"反推订阅"入口，含 TMDB 候选兜底 |
| `getMovieDetails` / `getTvDetails` | `providers/tmdb-provider.ts:278/310` | 未追踪时构造 `MediaTitle` |
| `handleMovieOrganize` / `handleTvOrganize` | `api/titles/organize/organize-handlers.ts` | 已接受 `title` 对象，方案 B 可直接喂临时对象 |
| `resolveCanonicalMovieDirectory` / `resolveCanonicalTvDirectory` | 同上 | 目录规范化，不依赖追踪态 |
| `listConnectedStorages` | 存储层 | 越权校验 |
| `route-auth-inventory.test.ts` | `apps/web/app/api/` | **同类门禁的现成范式**（断言路由必须调用某个校验函数） |

---

## 10. 门禁与回归测试设计（防复发）

### 10.1 同类门禁（新增，硬阻断）

参照 `route-auth-inventory.test.ts` 的做法，新增 `organize-route-contract.test.ts`：

| 断言 | 目的 |
| :--- | :--- |
| organize 路由源码**不得**出现 `"title not tracked"` 字面量 | 防止回退到裸 404 文案 |
| organize 路由必须调用 `listConnectedStorages`（或等价的归属校验） | 防止再次出现跨盘/越权 |
| `resolveOrganizeTarget` 必须接收 `connectedStorageId` 并传入 `listTrackedSeasonStates` | 防止跨盘错配回归 |

> 这类"源码结构断言"在本仓库已有先例（`callsFunction(playSource, "verifyStrmPlayToken")`），成本低、防回归效果好。

### 10.2 单元测试

```
resolveOrganizeTarget:
  - 已追踪 + 同盘            → ok，connectedStorageId = 请求盘
  - 已追踪 + 异盘            → 不得命中（修复 4.1）
  - 未追踪 + 无 storageId    → STORAGE_REQUIRED
  - 未追踪 + storageId + 未同意 adopt → NOT_TRACKED(409)
  - 未追踪 + storageId + 同意 adopt   → 调用 adopt 后命中
  - storageId 不属于账号     → STORAGE_FORBIDDEN(403)
```

### 10.3 契约/集成测试

```
POST /api/titles/organize
  - body 无 storageId（旧客户端）→ 409 + code=NOT_TRACKED（不得是 404 裸文案）
  - body 带 storageId + adoptIfUntracked=true → 200，且 repo 中出现该季追踪态
  - 传入他人 storageId → 403
```

### 10.4 浏览器回归（并入现有验收脚本）

```
网盘管理 → 进入 Anime/凡人修仙传 (2020) {tmdb-106449}
  → 点「整理与多版本归档」
  → 断言：不再出现 "title not tracked"
  → 出现确认弹窗 → 确认 → 断言成功提示 + 目录结构变化
```

### 10.5 门禁落地位置

`npm run gate` 目前串联了 `gate:contracts`、`gate:security`、代码行数棘轮等。建议把 10.1 的结构断言挂到 `gate:contracts`（或新增 `gate:organize-contract`），确保**任何一次提交**都会跑，而不是只靠人工验收。

---

## 11. 实施计划

| 期 | 内容 | 成本 | 验收 |
| :--- | :--- | :--- | :--- |
| **P0** | 错误语义改造：404 → 409 + `code` + `action`；前端弹确认框 | 0.5 天 | 点击整理给出可操作提示，不再是裸报错 |
| **P1** | 契约补 `storageId` + 归属校验 + 追踪态按盘过滤（修 4.1/4.2） | 1 天 | 跨盘不再错配；越权返回 403 |
| **P2** | `AdoptThenResolveResolver`：未追踪自动 adopt 后整理 | 1.5 天 | 未追踪目录一键整理成功，且库里出现该标题 |
| **P3** | 结构门禁 + 单测 + 浏览器回归 | 1 天 | `npm run gate` 能拦住回退 |

---

## 12. 风险

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| adopt 副作用 | 会在库里新增标题/季/集记录 | 显式确认；文案说明"不会触发下载" |
| TMDB 误配 | tmdbId 来自目录名，可能错 | adopt 前用 TMDB 返回的标题与目录名做一次相似度校验，不符则拒绝并提示 |
| 大目录耗时 | `listTree` + 逐集 adopt 可能很慢 | 限流 + 进度反馈；失败可续跑 |
| 并发 | 整理与追更任务同时操作同一目录 | 复用现有 run 互斥（`blockIfTitleHasActiveKinds`） |

---

## 13. 实施记录与实机验收

### 13.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| 错误语义 | `api/titles/organize/route.ts` | 未追踪由 `404 "title not tracked"` 改为 `409 {code:"NOT_TRACKED"}` + 可操作文案；目录缺失改为 `NO_STORAGE_DIRECTORY` |
| 契约补 storageId | 同上 `parseOrganizeRequestBody` | 新增可选 `storageId`（裁剪空白、非字符串忽略）；缺省时保持旧行为 |
| 归属校验 | 同上 `resolveOrganizeContext` | 传入的盘必须在 `listConnectedStorages(accountId)` 内，否则 `403 STORAGE_FORBIDDEN` |
| 按盘过滤追踪态 | 同上 `resolveOrganizeTarget` | `listTrackedSeasonStates({ accountId, connectedStorageId })`，修掉跨盘错配 |
| 引导式纳入 | `storage/use-folder-organize.ts` + `organize-adopt-prompt.tsx` | 收到 NOT_TRACKED → 黄色确认条（明确"不会触发下载或追更"）→ 调既有 `/api/storage/files/adopt` → 重试整理 |
| 视图瘦身 | `storage-manager-view.tsx` | 编排整体移入 Hook，视图 649 → 约 600 行，复杂度回到预算内 |

单测新增：`route-contract.test.ts`（4 例结构门禁）、`route.test.ts` 增补 storageId（3 例）、`use-folder-organize.test.ts`（7 例）。

### 13.2 结构门禁（防回归）

`apps/web/app/api/titles/organize/route-contract.test.ts` 用 **AST** 而非文本匹配断言：

1. 路由源码不得再出现 `title not tracked` 字面量；
2. 必须出现 `NOT_TRACKED` 错误码；
3. 必须真实调用 `listConnectedStorages`（AST CallExpression，注释/字符串不算）；
4. `listTrackedSeasonStates` 的实参里必须含 `connectedStorageId`（支持嵌套/条件对象）。

### 13.3 实机验收（开发实例 3020）

为让"未追踪"分支可复现，验收前删除了该标题在开发库中的 2 条 `workflow_runs`（仅 dev 数据）。

| 检查项 | 实测 | 结论 |
| :--- | :--- | :--- |
| 点击整理 | 出现黄色「尚未纳入媒体库…纳入并整理」确认条，**无** `title not tracked` | 通过 |
| 确认纳入 | 确认条消失、进入「整理中…」，无裸报错 | 通过 |
| 旧客户端（无 storageId，tmdb 999999） | `409 {code:"NOT_TRACKED"}` | 通过 |
| 越权 storageId | `403 {code:"STORAGE_FORBIDDEN"}` | 通过 |
| 控制台 | pageerror 0 | 通过 |

回归（同实例）：五页巡检 + R3–R6 全 true；播放器 UX（全屏 gap 0 / 复制 / 字幕 / V / 偏好记忆）全通过；字幕专项全通过；HUD 三档通过；详情页预热仍为 1 次 HEAD。

### 13.4 与方案的偏差

- **P2 由服务端自动 adopt 改为前端引导式编排**：adopt 会新增标题/季/集记录，属于可见副作用，必须由用户显式确认；且 `/api/storage/files/adopt` 已实现完整识别与快照写入，服务端重写会引入 200+ 行重复逻辑。代价是多一次往返，收益是零重复实现 + 用户可取消。
- **P3 的浏览器回归已并入** `test-results/browser-acceptance/verify-organize-adopt.mjs`，但**未**挂进 `npm run gate`（gate 只跑静态门禁与单测，浏览器验收仍是手动/脚本触发）。如需 CI 化，可另加 Playwright job。
