# 站长关键字投放四项增强（任意目录 / 链接时效 / 搜索后端选择 / 类型过滤）调研与落地方案

- 日期：2026-11-18
- 状态：**已实施**（未部署）
- 需求原话：
  1. 关键字投放（站长）选择影视库外目录提示 `WRITE_SCOPE_VIOLATION: refusing to transfer outside configured write scope`，能否优化允许投放到任意目录？
  2. 搜索结果能否支持自动验证分享链接是否过期？
  3. 查询条件能否支持选择已配置的搜索后端（可以单独选盘搜或其它搜索后端）？
  4. 结果过滤能否添加资源类型过滤（磁力 / 115 网盘链接等）？
- 附加要求：头脑风暴可行性与逻辑/性能欠缺；评估适配器策略模式与状态机；查现成库与业界方案；确认本仓已有基础设施可复用；写入 `docs`。
- 前置文档：[`2026-11-17-owner-keyword-manual-ingest-feasibility-and-design.md`](./2026-11-17-owner-keyword-manual-ingest-feasibility-and-design.md)（功能原始落地记录）

---

## 1. 结论先行

四项都可在现有基础设施上完成，**零新增依赖**：

| # | 需求 | 本质 | 结论 |
| --- | --- | --- | --- |
| 1 | 投放到任意目录 | 「写入范围」是**执行器的安全红线**，不是站长的业务限制 | 不改红线，改**授权粒度**：worker 在执行前只把「本 run 用户选的那一个目录」授权给执行器 |
| 2 | 自动校验分享时效 | 仓库**已有完整探测适配器注册表**，但只接在作品面板，且对 123/天翼/光鸭**谎报 valid** | 新增 owner 侧批量校验端点，并补登录态探针 |
| 3 | 选择搜索后端 | 后端装配原本是「设置页配了什么就全用」，选择只能**收窄** | 装配层加 `backends` 过滤；选择进冷却/缓存键 |
| 4 | 类型过滤 | **已经存在且已按策略/分面实现**，owner 控制台只是没用它 | 复用 `ResourceFilterBar` + `ResourcePaginationBar` |

一句话：三项是「把已有能力接上去」，一项是「把红线的授权粒度从『范围』改成『单目录』」。

---

## 2. 需求 1：允许投放到任意目录

### 2.1 根因：报错来自执行器，不是路由

`WRITE_SCOPE_VIOLATION` 只可能由执行器的 `assertWithinWriteScope` 抛出，五个品牌各有一份：

| 品牌 | 位置 | 校验方式 |
| --- | --- | --- |
| 115 | `packages/workflow/src/storage/storage-115-executor.ts:1429` | `getDirectoryInfo` 面包屑包含范围根 |
| 夸克 / UC | `packages/workflow/src/storage/quark-storage-executor.ts:452` | `pdir_fid` 逐级上溯 |
| 123 | `packages/workflow/src/storage/pan123-storage-executor.ts:1018` | derived-scope（无上溯接口） |
| 天翼 | `packages/workflow/src/storage/tianyi-storage-executor.ts:496` | derived-scope |
| 光鸭 | `packages/workflow/src/storage/guangya-storage-executor.ts:771` | derived-scope |

worker 用的执行器由 `createExecutorForConnectedStorage` 装配，`scopeCids = [rootCid, moviesCid, tvCid, animeCid]`
（`apps/web/features/acquisition/application/worker-runner-service.ts:991`）。所以落到 `Movies/TV/Anime` 之外必然被拒。

关键事实：**这条红线本身是对的**。它防的是「agent 把文件写进整盘任意位置」。但站长的投放是人工显式选择，
用户点中的目标目录就是他的意图，并不构成越权。

### 2.2 三种方案的取舍

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| A 把范围放宽到盘根 | `scopeCids` 加 `rootCid` 或置空 | 执行器从此对**所有**这个 run 的操作全盘可写（含删除/搬移），红线整体失效 |
| B 路由层绕过校验 | 提交端点不做任何校验 | 只解决 HTTP，worker 里执行器仍会拒；且失去「目标存在 / 不是盘根」的早期失败 |
| **C 显式单目录授权（采用）** | 新增 `authorizeWriteTarget(dirId)`，worker 在 `transfer` 前调用 | 授权**只覆盖这一个精确 id**，不传播给子目录/兄弟目录；执行器自己的校验照旧运行 |

方案 C 的关键设计：

```ts
// packages/workflow/src/domain/ports.ts:65
authorizeWriteTarget?(directoryId: string): void;
```

- **精确匹配**：只 `add` 这一个 id，不按前缀/父子关系放宽。用 115 的实现说明：
  ```ts
  // packages/workflow/src/storage/storage-115-executor.ts:590
  authorizeWriteTarget(directoryId: string): void {
    if (this.writeScopeDirectoryIds.size === 0) return;  // 无范围=全放行，加一个反而收窄
    this.writeScopeDirectoryIds.add(normalizeDirectoryId(directoryId));
  }
  ```
- **执行前授权**：`packages/workflow/src/execution/owner-ingest-worker.ts:114` 在 `storage.transfer` 之前调用，
  且目录取自 run 的审计记录（不是外部参数），保证「授权什么就转存什么」。
- **可选钩子**：`StorageExecutor` 是鸭子类型口，不区分写入范围的 executor 不实现即可；单测可注入假实现。

### 2.3 顺带补上的两层「早失败」

允许任意目录 ≠ 什么校都不做。提交端点现在校验两件与「能不能放」无关的事
（`apps/web/app/api/owner/ingest/submit/route.ts:109`）：

1. **不能是网盘账号根**：读 `StorageBrand.provisionRootId`（115/夸克/UC/123 = `0`，光鸭 = `""`，天翼 = `-11`）。
   往根投放会让根目录长满散文件，且落盘确认的 before/after 对比要枚举整盘（115 直接风控）。
2. **目标必须真实存在**：列表响应里的面包屑必须含目标 id。115 的 `/files` 对已删除的 cid **静默回落到账号根**，
   不校验就会「显示已排队、其实进了根目录」。

失败一律 `422` 且**不排队**——不制造注定失败的 run（原来的行为是排进队列后由 worker 失败）。

### 2.4 性能

- 授权本身零成本（内存 Set）。
- 目标校验是**每个批次一次**目录列表（不是每条候选一次），与随后的 `transfer` 共用同一把 115 限流节拍。
- 放弃路由层的 `guardWriteTarget` 反而少了一次可能的目录列表（原实现里它可能额外打一次 `getDirectoryInfo`）。

---

## 3. 需求 2：自动校验分享链接是否过期

### 3.1 仓库已有的东西（比预期完整）

`packages/workflow/src/inspectors/` 已经是一套**完整的适配器 + 注册表**：

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| `IShareInspectorAdapter` | `share-inspector-types.ts:44` | 适配器契约（`supportedTypes` + `inspect`） |
| `ResourceValidityStatus` | `share-inspector-types.ts` | 状态机：`idle / probing / valid / invalid / password_required / rate_limited / unknown` |
| `Pan115ShareInspectorAdapter` | `pan115-share-inspector.ts:130` | 匿名 `webapi.115.com/share/snap`，区分 `4100014` 等错误码 |
| `QuarkShareInspectorAdapter` | `quark-share-inspector.ts:106` | 匿名 `sharepage/token` + `sharepage/detail`，覆盖夸克/UC |
| `GenericShareInspectorAdapter` | `generic-share-inspector.ts` | 兜底 |
| `ShareInspectorRegistry` | `share-inspector-registry.ts:15` | 10 分钟缓存 + 单飞 |
| 端点 | `apps/web/app/api/titles/resources/inspect/route.ts` | 接在**作品面板**上 |

也就是说：**探测能力早就有了，只是没接到投放面板**。

### 3.2 真实缺口（三个，按严重度）

① **P0 逻辑：兜底适配器在说谎。**

改动前 `GenericShareInspectorAdapter` 把 `123 / tianyi / guangya` 也登记进来，并对任何非空 URL 直接返回 `valid`：

```ts
// 改动前
return { status: "valid", message: "资源链接就绪", ... };
```

用户看到「有效」→ 去投放 → 分享早已失效。**这不是探测，是猜**；而且它把「待探测」这个诚实的中间态吃掉了。

② **P1 逻辑：123/天翼/光鸭没有匿名入口，必须用登录态。**

这三个品牌的分享列表要求登录态（「空码穿透」），协议在各自的品牌 client 里：

- 123：`Pan123Client.listShareDir`（`pan123-client.ts:319`）
- 天翼：`TianyiClient.getShareInfo` + `listShareDir`（`tianyi-client.ts:394` / `:410`）
- 光鸭：`GuangYaClient.getShareAccessToken` + `listShareFiles`（`guangya-client.ts:273` / `:289`）

`GenericShareInspectorAdapter` 自带 `fetch`，拿不到这些凭据 —— 所以「补探测」= 补一层**注入已绑定凭据的探针**。

③ **P1 语义：作品面板的探测端点接不了投放。**

`/api/titles/resources/inspect` 要求 `tmdbId`，并按 `resourceSearchRunId(snapshotId)` 取快照。投放检索记录挂在
`owner_ingest_search_*` 上（`owner-ingest-service.ts:53`），两者 run id 推导不同，硬接必然 404。

### 3.3 方案

**A. 新增 `CredentialedShareInspectorAdapter`（适配器模式的第二次使用，不是第三份 if 链）**

```ts
// packages/workflow/src/inspectors/credentialed-share-inspector.ts
export type ShareProbeOutcome =
  | { kind: "listed"; files: ShareProbeFile[] }
  | { kind: "invalid"; message: string }
  | { kind: "password_required"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "unknown"; message: string };
```

适配器本身不碰存储层，只接收一个 `CredentialedShareProbe`。判定口径**保守**（与死链记录同源原则）：

| 情况 | 结论 | 理由 |
| --- | --- | --- |
| 列出文件 | `valid` + `fileCount` / `totalSizeBytes` | 权威 |
| 空列表（123/天翼） | `invalid` | 转存必然失败 |
| 空列表（光鸭） | `unknown` | 半失效分享「换 token 成功但列不出文件」 |
| 报「失效/取消/不存在/链接错误」 | `invalid` | 确定性死亡信号 |
| 报「提取码/访问码错误」 | `password_required` | 不是死链，是缺参数 |
| 限流 / 429 | `rate_limited` | 不写缓存，下一轮重试 |
| 账号授权失效（123 `Pan123AuthError`） | `unknown` | 该去重连盘，不是判这条资源死 |
| 抛错 / 超时 | `unknown` | **一次抖动不得把好资源判死** |

**B. 兜底适配器改成诚实**（`generic-share-inspector.ts`）：磁力仍是 `valid`（形状可判定，并明确文案「存活需由下载端确认」），
123/天翼/光鸭在无登录态探针时一律 `unknown`。

**C. owner 侧批量端点 `/api/owner/ingest/inspect`**

- 门禁 `requireOwner`（入 `OWNER_ROUTES`，`route-api-inventory` 的 AST 断言自动覆盖）；
- 单次上限 12 条（`MAX_INSPECT_CANDIDATES`），并发 2（`INSPECT_CONCURRENCY`）—— 分享详情接口对突发很敏感；
- **登录态探针优先**：用目标盘账号构造（`buildShareProbesForCredentials`，`share-probe-service.ts`），
  未覆盖的类型落回默认注册表（115/夸克/UC 的匿名适配器）；
- **不改全局单例**：默认注册表是进程级、跨账号共享的；把某块盘的凭据探针注册进去会让别的账号也用上它。
  这里用一个请求内包装（`withCredentialedProbes`，`inspect/route.ts:129`），并 `bypassCache` 免得一条过期缓存
  让站长看不到「刚刚复活」的链接。

**D. UI**：勾选后点「校验已选链接」，逐行徽章显示 `有效 / 已失效 / 需提取码 / 限流稍后再试 / 未校验`。
整体失败也一律落 `unknown` —— 不谎报。

### 3.4 为什么不做「自动全量校验」

用户问的是「自动验证」，实现上做成**一键批验**而不是「检索完自动跑一遍」：

- PanSou 一次返回 20–50 条，全量校验 = 20–50 次网盘详情请求，直接把 115 打进风控；
- 校验的价值集中在「你打算投的那几条」，勾选后再验既省请求也更准；
- 磁盘开销：注册表已按 `candidateId` 缓存，重复点不会重打。

如果将来要自动，正确做法是**按勾选/可见页惰性触发**（前端 IntersectionObserver），而不是检索回包即验。

---

## 4. 需求 3：选择搜索后端

### 4.1 现状

`getWorkerResourceProvider`（`worker-runner-service.ts:808`）按品牌 `resourceProviderKinds` 装配：

- 永远注册 PanSou；
- 品牌 `kinds` 含 `prowlarr`（115/光鸭/123）且设置页配了地址+Key 才加 Prowlarr；
- 配了 haisou key 才加海搜。

**没有任何「本次只用某几个源」的入口**，用户只能去设置页删配置。

### 4.2 关键约束

1. **选择必须能表达「不限制」**：空数组 / 不传 = 全部已配置后端。否则「取消最后一个勾选」会变成死状态。
2. **品牌约束优先**：Prowlarr 产磁力，夸克/UC/天翼没有磁力通道（`allowedResourceTypesForKinds` 只给他们自己的分享链），
   选了也只能得到转不进去的候选 → 装配层直接跳过。
3. **必须进冷却/缓存键**：不同源候选集合完全不同。共用一把键的话「先选盘搜、再换 Prowlarr」会在 30 分钟内
   命中上一次的缓存 —— 用户以为换源成功，实际什么都没变。

### 4.3 方案

**单一真相 `search-backends.ts`**（`packages/workflow/src/providers/search-backends.ts`）：

- `SearchBackend = "pansou" | "prowlarr" | "haisou"`，标签集中一处；
- `normalizeSearchBackends`：去重 + 固定顺序 + 丢弃未知值；
- `searchBackendsKey`：空 = `all`，子集 = 排序后拼接。

**装配层**（`getWorkerResourceProvider(..., { backends })`）：每个注册块前过 `makeBackendSelector(backends)`
（`search-backend-selector.ts`，独立成文件是为了控制装配函数的行数/复杂度门禁）。

**服务端校验**（`owner/ingest/search/route.ts`）：

- `GET` 返回 `backendsByStorage`（每块盘**可用**的后端 + 是否**已配置**，`resolveSearchBackendViews`）；
- `POST` 里选的若不在该盘可用列表 → `400`；可用但未配置 → `409`。
  **不允许静默丢弃**：用户选了 Prowlarr 却只跑了盘搜，是最坏的一种「看起来成功」。

**冷却/缓存键**：`ownerIngestCooldownKey(accountId, keyword, backends)` → `owner_ingest|acct|all|<kw>` 或
`owner_ingest|acct|pansou+prowlarr|<kw>`。

**UI**：`BackendPicker` 渲染后端 chips，未配置的置灰并标注「未配置」；空选择显示「全部已配置后端」。

### 4.4 状态机的复用判断

`SearchProviderRegistry` 内部已有**熔断状态机**（`healthy / degraded / circuit_open / half_open`），
`FallbackResourceProvider` 已有「主源坏 → 备源 + 整体标 degraded」的状态语义。本次选择功能**不新建状态机**：
选择是**请求级策略**，不是跨请求状态 —— 给它建一个 FSM 只会增加一个需要持久化、需要和配置页同步的状态源。
（本仓库真正需要状态机的流程已经在用：`acquisition-v2/run-state-machine.ts` 的 xstate、`library-scan-job` 的迁移表。）

---

## 5. 需求 4：资源类型过滤

### 5.1 已经存在

`apps/web/features/acquisition/contracts/resource-filter-model.ts` 早就实现了：

- 分面统计 `extractFacets`（类型 / 分辨率 / 规格 / 体积，`countTypes` 就是按 `ResourceType` 计数）；
- 过滤 `filterCandidates`（`criteria.type` 直接比较 `c.type`）；
- 排序 + 分页纯函数；
- UI 组件 `ResourceFilterBar` / `ResourcePaginationBar`（作品面板在用）。

`ResourceType` 已含 `115 / magnet / quark / uc / tianyi / 123 / guangya / manual`，即「磁力 / 115 网盘链接」本身就是一个分面值。

### 5.2 owner 控制台之前为什么没有

上一轮实现只放了两个自制下拉框（分辨率 + 排序），因为控制台是**新页面**，没有走分面组件。
这不是能力缺口，是接线遗漏 —— 同时也造成两套 UI 的筛选语义不一致。

### 5.3 方案

- 控制台改用 `ResourceFilterBar` + `ResourcePaginationBar`（`owner-ingest-console-parts.tsx`）；
- 分页状态（`page` / `pageSize`）进容器，改筛选自动回第 1 页；
- 保留「勾选跨页保持」：`selectedIds` 是 `Set`，翻页/筛选不丢；
- **纯展示**：不改服务端 verdict、不重发检索（守 `gate:client-filtering` 与上一轮的「客户端不判定」原则）；
- `mapRunStatusToPhase` 搬到 parts 模块（容器只留状态与请求）——同时满足 `gate:limits` 的 600 行棘轮。

### 5.4 性能

过滤/分面/分页都在已取回候选上做（20–50 条），O(n) 正则 + 排序，<1ms，不消耗索引器预算。
`ResourceFilterBar` 的关键词输入是即时过滤，不触发网络。

---

## 6. 业界对比

| 维度 | Sonarr / Radarr | Prowlarr | MoviePilot | OpenList | 本项目（本次） |
| --- | --- | --- | --- | --- | --- |
| 手动落点 | 必须已有实体，落 root folder | — | 手动下载 + 指定整理目标 | **任意云端目录** | **任意目录**（拒盘根/不存在） |
| 源选择 | 按 indexer 启停 | indexer 统一管理、按 app 同步 | 插件级 | — | **本次检索级多选** |
| 协议/类型过滤 | Protocol 延迟策略 | category 同步过滤 | 资源类型偏好 | — | **分面（类型/分辨率/规格/体积）** |
| 链接存活 | 抓取后由 download client 报错 | indexer test | 转存失败即失败 | — | **投放前显式校验（保守三态）** |

要点：

- Sonarr 的「互斥协议优先级」是**延迟策略**（delay profile），而不是硬开关；本项目的「后端选择」同样刻意做成
  「本次收窄 + 不限制为默认」，而不是持久化的启停开关 —— 启停归设置页，检索归用户。
- Prowlarr 的经验证明「索引器可用性」是有状态的（`test indexer`、失败降级）；本项目已有同构能力
  （`SearchProviderRegistry` 熔断 + `recordPanSouHealth`），选择功能**复用**它而不是新建一套。
- MoviePilot 的「先算目标路径再执行」对应本项目的 `verifyOwnerTarget`（提交前 422 而不是排队后失败）。

参考来源：

- Sonarr/Radarr 设置（Protocol、Delay Profile）：https://wiki.servarr.com/radarr/settings
- Usenet vs Torrent（两协议共存、由延迟策略决定谁先）：https://arrcade.co.uk/blog/usenet-vs-torrents-sonarr-radarr
- Sonarr 索引器按需启停（Enable RSS / Enable Search）：https://docs.seedboxes.cc/howtos/how-to-connect-nzbget-sabnzbd-to-sonarr-radarr
- Prowlarr FAQ（indexer 同步与 category 过滤）：https://wiki.servarr.com/prowlarr/faq
- OpenList 离线下载到指定云端目录：https://doc.oplist.org/guide/advanced/offline-download
- PanSou 搜索 API 参数（`kw` / `res` / `src` / `plugins` / `cloud_types` / `filter`）：https://github.com/fish2018/pansou
- 115 分享嗅探接口 `share/snap` 与风控说明：本仓 `docs/115-api-safety-notes.md`

> PanSou 的 `cloud_types` 参数（`baidu/aliyun/quark/guangya/tianyi/uc/mobile/115/pikpak/xunlei/123/magnet/ed2k`）
> 可以做**上游侧**类型过滤。本项目没有改用它，原因是 `normalizeResourceType` 已经按 URL 形状做同一判定，
> 再在上游过滤会引入第三套映射表；类型过滤在客户端分面即可（需求 4）。将来若要在服务端减少传输量，
> 把 `allowedTypes` 映射成 `cloud_types` 是低风险增量（映射表须与 `normalizeResourceType` 同源）。

---

## 7. 设计模式的复用与取舍

| 模式 | 本次是否新建 | 说明 |
| --- | --- | --- |
| **适配器** | 复用 + 扩一个实现 | `IShareInspectorAdapter` 原样复用；新增 `CredentialedShareInspectorAdapter` 承载「需要登录态」的协议差异。品牌分发**没有**新增 if 链 |
| **策略** | 复用 | 筛选/排序/分面本就是策略族（`resource-filter-model`）；后端选择是 `makeBackendSelector` 纯函数策略 |
| **状态机** | **刻意不新建** | 校验已有 `ResourceValidityStatus` 词表（无迁移表，只有终态）；检索后端已有熔断 FSM。为一个「请求级选择」建 FSM = 多一个要持久化的状态源 |
| **单飞 / 缓存** | 复用 | 注册表已有 10 分钟缓存 + in-flight 合并；owner 侧用 bypassCache 换取「刚复活可见」 |

---

## 8. 落地清单

| 需求 | 交付 | 位置 |
| --- | --- | --- |
| 1 | `authorizeWriteTarget` 口 + 五品牌实现（精确单目录、无范围时 no-op） | `packages/workflow/src/domain/ports.ts:65`、各 executor |
| 1 | worker 在 transfer 前授权 | `packages/workflow/src/execution/owner-ingest-worker.ts:114` |
| 1 | 提交端点：拒盘根 / 拒不存在目录（422，不排队），移除路由层范围守卫 | `apps/web/app/api/owner/ingest/submit/route.ts:109` |
| 2 | 登录态探测适配器 + 错误分类 | `packages/workflow/src/inspectors/credentialed-share-inspector.ts` |
| 2 | 兜底适配器不再谎报 valid | `packages/workflow/src/inspectors/generic-share-inspector.ts` |
| 2 | 凭据探针装配（123/天翼/光鸭） | `apps/web/features/storage-drives/application/share-probe-service.ts` |
| 2 | 批量校验端点（上限 12 / 并发 2） | `apps/web/app/api/owner/ingest/inspect/route.ts` |
| 2 | 勾选批验 + 行内徽章 | `owner-ingest-console-parts.tsx` |
| 3 | 后端枚举/标签/键 单一真相 | `packages/workflow/src/providers/search-backends.ts` |
| 3 | 装配层 backends 过滤 + 选择器 | `worker-runner-service.ts`、`search-backend-selector.ts` |
| 3 | 服务端校验（不可用 400 / 未配置 409）+ GET 返回可用后端 | `apps/web/app/api/owner/ingest/search/route.ts` |
| 3 | 冷却/缓存键含后端组合 | `owner-ingest-service.ts:51` |
| 4 | 分面筛选 + 分页复用，删自制下拉 | `owner-ingest-console.tsx`、`owner-ingest-console-parts.tsx` |

---

## 9. 门禁与回归测试

| # | 守什么 | 形态 |
| --- | --- | --- |
| G1 | 新端点必须站长专属 | `OWNER_ROUTES` 增 `owner/ingest/inspect`；`route-auth-inventory.test.ts` 断言源码**真的** import 并调用 `requireOwner`，且不得用 `requirePermission` 冒充（21 条全绿） |
| G2 | 授权不外泄、不传播 | `storage-115-executor.test.ts`：授权前拒 → 授权后成功 → **兄弟目录仍拒**；无范围时授权 no-op（全放行不被收窄） |
| G3 | 授权发生在转存之前、用 run 里的目录 | `owner-ingest-worker.test.ts`：调用顺序 `["authorize", "transfer"]`，参数等于 run 审计记录里的目标 |
| G4 | 兜底适配器不得谎报 | `credentialed-share-inspector.test.ts`：123/天翼/光鸭非磁力 → `unknown`（显式断言「不得 valid」） |
| G5 | 保守判定 | 同文件：空列表按 `emptyMeans` 分档；探针抛错 → `unknown`；失效/提取码/限流透传；错误分类只认确定死亡信号 |
| G6 | 后端选择进键 | `owner-ingest-service.test.ts`：`all` ≠ `pansou`；`[prowlarr,pansou]` == `[pansou,prowlarr]`；未知值被丢弃 |
| G7 | 请求体契约 | `owner-ingest-body.test.ts`：搜索 body 带 `backends` 规范化；校验 body 上限 12、缺字段各拒 |
| G8 | 行数/体积棘轮 | `gate:limits`（控制台拆出展示模块后 PASS，baseline 按既定策略 re-baseline） |

本次运行的验证：

- `npx tsc --noEmit`：`apps/web` 与 `packages/workflow` 双项目通过；
- `npx eslint`（改动范围）：0 告警；
- `npx vitest run packages/workflow/tests/{storage,providers,execution,inspectors} apps/web/app/api/owner apps/web/features/storage-drives apps/web/lib apps/web/app/api/route-auth-inventory.test.ts`：
  **227 个测试文件 / 2800 条用例全绿**；
- 门禁：`gate:limits`、`gate:client-filtering`、`gate:contracts`、`gate:policy`、`gate:identity`、`gate:parity`、`gate:facades`、`gate:style` 全部 PASS。

---

## 10. 已知限制与明确不做

- **不做「检索完自动全量校验」**：会以 20–50 次/词的速度打网盘详情接口。改成勾选批验（上限 12 / 并发 2）。
- **不把 `authorizeWriteTarget` 传播给子目录**：用户选中的是那个目录；让子目录也自动可写等于把红线重新变成「范围」。
- **不放宽 `validateWorkflowRunSnapshot` / 不改 run kind**：四项需求都不需要新的 run 形态。
- **不让客户端判定可提交性**：筛选是展示层，`queued/rejected` 仍只由服务端 verdict 产生。
- **不为后端选择新建持久化状态机**：选择是本次检索的策略；启停/配置仍归设置页。
- **光鸭「空列表」判 unknown 而非 invalid**：其半失效分享确实可能只有摘要可取，宁可让用户看到「未校验」。
