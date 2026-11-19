# `/show/0` 打不开：投放记录（无 TMDB 身份）泄漏进了「已追踪作品」

- 日期：2026-11-19
- 状态：调研完成（含门禁设计），方案待实施
- 触发现象（生产 `/library` → 点击「骚货」卡片）：
  - 卡片：`骚货` · 电影 · **0** 已获 0/2 集 · 缺 1 集 · 0%
  - 链接：`http://<host>:3000/show/0?from=library&t=movie`
  - 结果：整页「页面渲染失败」，服务端 digest `601406719`
- 证据来源：生产容器 `mediary` 的 `data/mediary.db` 只读查询 + 源码审计 + Dev 3020 复现

---

## 1. 结论先行

**这不是「某部片子坏了」，而是一条以 `tmdbId = 0` 为哨兵的投放记录，被三个「读已追踪作品」的入口当成了真实作品。**

三件事叠加，缺一不可：

1. **`owner_ingest`（站长关键字投放）在没有作品身份时，会写一条合成标题**：
   `tmdbId: 0, type: "movie"`，id 形如 `owner_ingest_<storageId>_<keyword>`
   （[owner-ingest-command.ts:44](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/owner-ingest-command.ts#L44)）。
2. **「已追踪作品」的读取层不过滤合成标题**。`isVisibleTrackedSnapshot`
   只排掉 `resource_search` 与 janitor 行
   （[repository.ts:2827](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/repository.ts#L2827)），
   `scopedRunRows` 同样只排 `resource_search`
   （[sqlite.ts:1427](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts#L1427)）。
   于是投放记录进入了影视库海报墙、每日巡检队列。
3. **`/show/[tmdbId]` 在拿到 `tmdbId=0` 时不做守卫**，直接把 0 传给
   `buildMovieCandidateId`，后者要求正整数并抛错
   （[media-identity.ts:112](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/media-identity.ts#L112)），
   整页渲染炸掉。

**上一轮的修复只做了一半**：`isUserVisibleWorkflowKind` 把 `owner_ingest` 从
活动流/通知里隐藏了（[domain.ts:61](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/domain.ts#L61)），
但影视库海报墙读的是**已追踪季**，不是 run——隐藏了 `kind` 不等于隐藏了 season。

### 1.1 生产数据实锤

```
media_titles 中 tmdbId=0 的标题：3 条
  owner_ingest_cs_340802261_骚货            movie  "骚货"
  owner_ingest_cs_340802261_骚货_后入        movie  "骚货 后入"
  owner_ingest_cs_340802261_网红_骚货_后入   movie  "网红 骚货 后入"

同名标题下的季：
  owner_ingest_cs_340802261_骚货_s1      status=completed  total=1  latest=1   ← 投放自己写的
  owner_ingest_cs_340802261_骚货_movie   status=completed  total=1  latest=1   ← 巡检又建了一条

会话记录（按时间）：
  owner_ingest_search_*      resource_search  succeeded   ← 检索
  26d060af-…                 owner_ingest     succeeded   ← 投放落盘（audit: queued|claimed|landed）
  307e29c6-…                 movie_init       no_coverage ← 22:03 巡检把它当电影去获取
```

`307e29c6` 的季 id 是 `…_骚货_movie`，而不是投放自己写的 `…_s1`
——**巡检用 `movieAnchorSeason()` 又造了一条季**，同一个合成标题下于是有了两条季。

Dev 3020 库里同类数据有 10 条合成标题、16 条季，症状一致（可复现）。

### 1.2 为什么 `/show/0` 恰好崩在候选 id 上

```
getDetailView(0, …)          → trackedForTitle 命中 tmdbId===0 的 movieState
                             → movieHubViewFromTitle(...) 返回 kind:"movie", tmdbId:0
MovieHub 渲染                → buildMovieCandidateId({ source:"tmdb", id: 0 })
media-identity.ts:113        → assertPositiveInt(0) → throw
                             "movie candidate id 必须是正整数，收到 0"
```

服务端日志与页面 digest 一致：

```
Error: movie candidate id 必须是正整数，收到 0    digest: '601406719'
```

> 顺带：`/notifications` 早前也出现过 `Missing tracked season tmdb_tv_95479_s1`
> 的同族失败——那是验收夹具造的孤儿季。两者是同一类问题的两个面：
> **读取层假设「季记录一定存在且身份一定合法」，而写入层允许两者都不成立。**

---

## 2. 根因分层

| 层 | 缺陷 | 后果 |
| --- | --- | --- |
| **写入** | 投放允许无身份（设计如此，是对的），但合成标题与真实作品**共用同一张表、同一套读取入口** | 无身份记录进入了「作品」语义 |
| **读取** | `listTrackedSeasonStates` / `listAllTrackedSeasonStates` / `getTrackedSeasonState` 只排 `resource_search` | 海报墙、巡检、取消追踪全部把 `tmdbId=0` 当作品 |
| **巡检** | 电影分支只看「是否已入库 / 是否未上映」，不看身份是否合法（[worker.ts:452](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/worker.ts#L452)） | 对 `tmdbId=0` 发起 `movie_init`，白烧一次 LLM + 搜索 |
| **渲染** | `/show/[tmdbId]` 只校验 `Number.isInteger`（[page.tsx:112](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/show/%5BtmdbId%5D/page.tsx#L112)），不校验 `> 0` | 整页 500 |
| **分组** | 海报墙按 `tmdbId` 建 Map（[title-hub-wall.ts:51](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/title-hub-wall.ts#L51)） | **所有** `tmdbId=0` 的投放记录会被折叠成一张卡（「骚货」其实是三条记录合并的结果） |

最后一条解释了截图的怪异之处：`0 已获 0/2 集`——`0` 是 `entry.year`（合成标题 `year: 0`），
`0/2 集` 是把三条记录的季数与集数加总后的结果。

---

## 3. 现有可复用的基础设施（不需要新库）

| 能力 | 现有实现 | 本方案怎么用 |
| --- | --- | --- |
| 身份解析 | `parseTitleId()`（[media-identity.ts:187](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/media-identity.ts#L187)）对 `owner_ingest_*` 返回 `not_a_title_id` | 直接作为「这是不是真实作品」的判据，不新造字符串前缀判断 |
| 隐藏 kind | `isUserVisibleWorkflowKind`（已有 `owner_ingest` 分支） | 复用同一份语义，避免出现第二份「哪些 kind 算作品」的清单 |
| 正整数断言 | `assertPositiveInt` | 渲染层与巡检层复用 |
| 投放状态 API | `GET /api/owner/ingest/status` | 投放记录的正确归宿（已实现，无需新增） |
| 门禁基座 | `tools/gates/*.mjs` + `.test.mjs` | 新增一条静态门禁 |

结论：**不需要引入 Tailwind/Radix 之类的 UI 库，也不需要新增数据库列或表。**

---

## 4. 业界主流做法对比

| 系统 | 如何处理「没有外部 id 的条目」 | 对本项目的启示 |
| --- | --- | --- |
| **Sonarr / Radarr** | 所有 library 条目都以 TVDB/TMDB **强身份**为键；「Manual Import」只能把文件匹配到**已存在**的剧集/电影，匹配不上就留在「活动」里等人工确认，**绝不新建一个无 id 的 library 条目** | 身份是 library 的准入条件，不是可选字段 |
| **Radarr 的「Add Movie」** | 必须先搜 TMDB 选中一条结果才建条目；没有「跳过元数据直接建」的入口 | 无身份 = 不属于 library |
| **Prowlarr（索引器层）** | 搜索结果只是「候选」，不进 library | 投放的检索结果同理：是候选，不是作品 |
| **Lidarr / Readarr** | 有「导入列表」与「手动库」之分，两者是不同的集合，UI 与数据表分离 | 投放记录应有自己的集合名（已有 `/storage/owner-ingest` 与 status API） |
| **AI agent 工程（2026）** | 反复强调「sentinel value 必须与真实值在类型上可分」（0/"" 这类哨兵一旦混入真实值域，就会在最远处炸开） | `tmdbId=0` 必须在类型层或读取层被挡住 |

**共同结论**：无身份记录可以有，但**必须在读取入口处与有身份作品分开**，
而不是靠调用方记得检查。

---

## 5. 具体方案

### 5.1 P0：读取层收口（一处改动解决三个症状）

在 `packages/workflow/src/domain/domain.ts` 增加单一判据（与 `isUserVisibleWorkflowKind` 并列）：

```ts
/**
 * 这条 run 的「作品身份」是否可用于已追踪作品语义（海报墙 / 巡检 / 取消追踪）。
 *
 * `owner_ingest` 在用户只给关键字时用合成标题承载 run 记录（tmdbId=0）。
 * 它是**投放记录**，不是作品：不能出现在影视库里，不能被巡检当成电影去获取，
 * 也不能被「取消追踪」这一类按 tmdbId 枚举的操作碰到。
 * 判据用 parseTitleId 而不是 `id.startsWith("owner_ingest_")`：后者是字符串
 * 前缀的重复硬编码，未来换前缀就会静默失效。
 */
export function isTrackedTitleIdentity(title: MediaTitle): boolean {
  return title.tmdbId > 0 && parseTitleId(title.id).ok;
}
```

三个读取入口统一用它过滤：

| 入口 | 现状 | 改为 |
| --- | --- | --- |
| `SqliteWorkflowRepository.listTrackedSeasonStates`（[sqlite.ts:1334](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts#L1334)） | 只排 `resource_search` | 加 `isTrackedTitleIdentity` |
| `.listAllTrackedSeasonStates`（[sqlite.ts:1345](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts#L1345)） | 同上 | 同上 |
| `.getTrackedSeasonState`（[sqlite.ts:1315](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts#L1315)） | 不判身份 | 同上 |
| `InMemoryWorkflowRepository` 三个同形方法（`isVisibleTrackedSnapshot`） | 只排 `resource_search` | 同一个判据 |

> 为什么放在 repository 而不是各个 UI：海报墙、巡检、取消追踪、MCP agent library、
> 订阅策略预览……**至少 12 个调用点**都在用 `listTrackedSeasonStates`。
> 在 UI 逐处判等于制造 12 份不一致的机会；`isVisibleTrackedSnapshot` 已经是
> 「哪些 run 算已追踪」的单一出口，它才是正确答案的位置。

### 5.2 P1：巡检防御（纵深）

即使读取层收口，也应让巡检自己拒绝无身份作品——它是唯一会**花真钱**（LLM + 搜索）的消费者：

```ts
// worker.ts 电影分支
if (s.title.type === "movie") {
  if (!isTrackedTitleIdentity(s.title)) continue;   // ← 新增
  if (s.episodes.some((e) => e.obtained)) continue;
  if (isMovieUnreleased(s.title.releaseDate, now())) continue;
}
```

同时 `queueMovieAcquisition` 入口处 `assertPositiveInt(title.tmdbId)`，
让「用无身份标题排队电影获取」在**排队那一刻**就失败，而不是烧完 token 才在渲染层炸。

### 5.3 P2：`/show/[tmdbId]` 的身份守卫与降级页

当前只校验 `Number.isInteger`。改为：

```ts
const tmdbId = Number(tmdbIdParam);
const view = Number.isInteger(tmdbId) && tmdbId > 0
  ? await getDetailView(...)
  : null;
```

并把「没有找到这部影片」的空态拆成两种措辞：

| 情形 | 文案 |
| --- | --- |
| `tmdbId <= 0` 或非整数 | 「这个链接不是有效的作品页」+ 返回影视库 |
| 合法 id 但 TMDB / 库内都没有 | 现有「没有找到这部影片」 |

> 0 号 id 在 TMDB 里不存在，保留「没有找到这部影片」会让用户以为片源问题。

### 5.4 P3：清理存量（无历史兼容包袱，直接删）

用户已明确「没有正式发布，不用考虑历史数据兼容」。建议一次性脚本（不进 CI）：

```
删除 owner_ingest 合成标题及其 tracked_seasons / episode_states / workflow_runs / notifications，
以及巡检误建的 *_movie 季
```

判据：`media_titles.tmdb_id = 0`（或 `parseTitleId(id).ok === false`）。
删除范围仅限这些无身份记录，**不触碰任何真实作品**。
`/storage/owner-ingest` 页与 `/api/owner/ingest/status` 不依赖这些行
（status 读的是 run 记录本身，而那些 run 属于投放，可保留或一并清）。

> 注意：**不做自动迁移**。存量就是脏数据，清掉即可；
> 加一层"历史数据兼容"只会把哨兵值的复杂度长期留在读取层。

### 5.5 明确不做

- **不给合成标题伪造一个负数/超大 tmdbId**：那只是把哨兵换个值，问题依旧。
- **不把投放记录塞进「订阅」墙**：投放本来就没有订阅语义（`season.status: completed`，
  自身设计如此），让它出现是语义错误，而不是展示偏好。
- **不在海报墙按 `tmdbId` 之外的键分组来「绕过」**：分组键不是根因，读取层才是。

---

## 6. 门禁与回归测试

### 6.1 单元测试

| 文件 | 用例 |
| --- | --- |
| `packages/workflow/tests/domain/tracked-title-identity.test.ts` | `tmdbId=0` → false；`owner_ingest_*` id → false；真实 `tmdb_tv_95479` → true；`douban_movie_123` → true |
| `packages/workflow/tests/persistence/tracked-season-identity.test.ts` | 写入一条 `owner_ingest` 的 run + 一条真实 tv run → `listTrackedSeasonStates` 只返回后者；`listAllTrackedSeasonStates`（巡检源）同样只返回后者；`getTrackedSeasonState(合成季)` 返回 null |
| `apps/web/lib/title-hub-wall.test.ts`（已有则扩展） | 混入合成标题后海报墙条目数不变、不出现 `tmdbId: 0` |
| `packages/workflow/tests/execution/patrol-identity.test.ts` | `runScheduledType3` 的候选里含 `tmdbId=0` 的电影季 → 不产生任何 queued run |
| `apps/web/app/show/.../page`（纯函数侧） | `tmdbId=0` → 渲染「不是有效的作品页」而不是抛错 |

### 6.2 新增门禁 `tools/gates/check-tracked-identity.mjs`

断言四件事（与既有 `check-blame-free-reporting` 同形制）：

1. **读取层收口**：`sqlite.ts` 与 `repository.ts` 的「已追踪季」读取都必须经过
   `isTrackedTitleIdentity`（符号出现于 `listTrackedSeasonStates` /
   `listAllTrackedSeasonStates` / `getTrackedSeasonState` / `isVisibleTrackedSnapshot` 四个函数体内）。
2. **巡检防御**：`worker.ts` 的电影分支必须含 `isTrackedTitleIdentity`。
3. **排队守卫**：`queueMovieAcquisition` 必须对 `title.tmdbId` 断言正整数。
4. **渲染守卫**：`apps/web/app/show/[tmdbId]/page.tsx` 必须同时出现
   `Number.isInteger(tmdbId)` 与 `tmdbId > 0`。

> 判据是「哨兵值有没有可能在任何一个读取/花费路径上被当成真实值」。
> 只要少一条，`/show/0` 这一类事故就会在别的入口复现。

### 6.3 端到端（可选）

Dev 3020 造一条 `owner_ingest` 投放 → 断言：
- `/library` 不再出现该卡片；
- 手动触发一次巡检不产生新 run；
- 直接访问 `/show/0` 返回降级页（200），不是 500。

---

## 7. 参考

- 本仓同族教训：`docs/research/2026-11-18-no-coverage-model-error-blame-free-reporting-research.md`
  （「哨兵值/系统故障在最远处炸开」的同一形态）、`docs/postmortems/strm-generation-empty-and-false-paused-state.md`
- 业界做法：
  [Sonarr Manual Import 只匹配已有条目](https://wiki.servarr.com/sonarr/system)、
  [Radarr 必须先选 TMDB 结果才能添加](https://forums.unraid.net/topic/53807-support-binhex-radarr/page/36/)、
  [Prowlarr 的搜索结果只是候选](https://www.freshports.org/net-p2p/prowlarr/pkg-plist)、
  [清理无主条目的实践讨论](https://www.reddit.com/r/sonarr/comments/1632w1e/i_created_a_tool_to_remove_inactive_media_from/)

---

## 8. 实施记录（2026-11-19）

### 8.1 落地清单

| 阶段 | 交付 | 位置 |
| --- | --- | --- |
| 判据 | `isTrackedTitleIdentity()` + `SYNTHETIC_TITLE_ID_PREFIX`（`tmdbId > 0` 与非合成前缀，两个条件缺一不可） | [tracked-identity.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/tracked-identity.ts) |
| 读取层 | `SqliteWorkflowRepository` 与 `InMemoryWorkflowRepository` 的 `getTrackedSeasonState` / `listTrackedSeasonStates` / `listAllTrackedSeasonStates` 全部经该判据过滤 | [sqlite.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts)、[repository.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/repository.ts) |
| 巡检防御 | 电影分支在「已入库 / 未上映」之前先判身份 | [worker.ts:452](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/worker.ts#L452) |
| 排队守卫 | `queueMovieAcquisition` 在排队那一刻拒绝 `tmdbId <= 0` | [commands.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/commands.ts) |
| 渲染守卫 | `parseTmdbIdParam()` 纯函数（`Number.isInteger && > 0`）+ `ShowNotFound` 区分「非法链接」与「查不到」 | [show-page-params.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/catalog/core/show-page-params.ts)、[show-not-found.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/catalog/components/show-not-found.tsx) |
| 门禁 | `check-tracked-identity.mjs`（五项检查）+ 注册 `gate:tracked-identity` 到 `npm run gate` | [tools/gates/](file:///E:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-tracked-identity.mjs) |

### 8.2 实现中的一处调整（与方案不同，但更严格）

方案原本把判据放在 `domain.ts`。实跑门禁时它触发了**两条**限制：`domain.ts` 已顶到
600 行硬上限（新增后 615 行），且既有棘轮不允许 +行数。

因此判据与常量搬到独立文件 `domain/tracked-identity.ts`，`domain/index.ts` 桶导出。
这比塞进 `domain.ts` 更好：判据与领域类型无关，独立文件也让门禁能直接定位它。

> 三个消费文件（`worker.ts` / `repository.ts` / `sqlite.ts`）仍各 +1 行 import，
> 按既有决策 `--update-baseline` 固化（棘轮存量文件合法变更）。

### 8.3 实机验证（Dev 3020）

| 检查 | 结果 |
| --- | --- |
| `/show/0?from=library&t=movie` | **200**，显示「这个链接不是有效的作品页 / 请从影视库或搜索页重新进入。」（此前整页 500） |
| `/?tab=library&status=completed` | 30 张作品卡，`href` 全部是真实 tmdb id（`/show/941132` 等）；`show0: []`；「骚货」已不出现 |
| 控制台 | 无水合错误、无 pageerror |

Dev 库此前有 10 条 `tmdbId=0` 合成标题、16 条季；收口后它们全部不再出现在
海报墙 / 巡检 / 详情页。

### 8.4 质量门禁

- `lint` / `typecheck` / `npm run gate`（含新增 `gate:tracked-identity`）全绿
- `packages/workflow/tests` 全量 **289 文件 / 3398 用例**通过
- 新增用例 25 条：`tracked-title-identity.test.ts`(7) +
  `tracked-season-identity.test.ts`(5) + `patrol-identity.test.ts`(6) +
  `show-page-params.test.ts` 扩展(2) + `check-tracked-identity.test.mjs`(1)
  （其余为既有套件覆盖）

### 8.5 存量数据

**不做自动迁移，也不写清理脚本进版本库。** 理由：

1. 用户已明确「未正式发布，不考虑历史数据兼容」——加兼容层会把哨兵值的复杂度
   长期留在读取层；读取层收口后，存量脏数据**天然不可见**，后果已经在
   `/show/0` 的降级页上被吸收。
2. `owner_ingest` 记录本身仍是有效的投放历史（`/api/owner/ingest/status` 读它），
   全删会丢掉用户的操作记录。

若要物理清库（释放 `media_titles` / `tracked_seasons` 的孤儿行），需人工执行一次性
SQL（判据：`json_extract(payload, '$.tmdbId') = 0`），**不属于本次交付**。
