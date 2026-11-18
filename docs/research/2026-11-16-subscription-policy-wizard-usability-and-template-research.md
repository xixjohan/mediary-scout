# 订阅向导「策略」步：模板无法保存、默认词杀召回、预览无诊断、搜索无进度

- 日期：2026-11-16
- 状态：**已实施**（方案 §5 全部落地 + G1–G8 门禁 + Dev 3020 实机验收；生产未动）
- 实施记录见文末 §12。
- 触发反馈（用户截图：创建订阅 → 第 2 步「策略」）：
  1. 为什么无法保存规则模板？能否优化？
  2. 默认模板能否去除「简中字幕」？
  3. 预览搜不到资源时能否加提示？无提示不够友好。
  4. 资源搜索等待很长时间且没有进度，能否优化？
  5. 「设置资源筛选规则」是否还存在其它交互问题？
- 附加要求：头脑风暴可行性/逻辑/性能欠缺，评估适配器策略与状态机设计模式，查现成库与业界方案，确认本仓已有基础设施可复用，写入 docs。
- 性质：只读源码审计 + 本地 SQLite 探针 + 缺陷本地复现；未改代码、未部署。

---

## 1. 结论先行

| # | 现象 | 本质 | 定位 |
| --- | --- | --- | --- |
| 1 | 向导里保存不了模板 | 模板 CRUD 在两处被手写了两遍，向导那份是**只读副本**（只有「选择/应用」，没有保存/更新/删除） | P0 功能缺失 |
| 1b | 去详情页保存也 400 | 客户端生成的优先级组 ID 是 **42 字符**（`group_` + UUID），服务端校验 `^[\w-]{1,40}$` ⇒ 带优先级组的草稿一律存不进 | P0 硬 bug |
| 2 | 默认 `1080p, 简中字幕` | 过滤是 **AND + 子串**，而真实资源名几乎不写「简中字幕」这四个字（仓库内有实测注解：写作 `CHS`/`简繁`/`双语`/`中字`，官方源标题多不写「中字」）⇒ 默认规则自己把召回打到 0 | P0 默认值即缺陷 |
| 3 | 预览 0 结果无提示 | 预览只回计数器，不带 sourceHealth、上映日期、关键词分层诊断；仓库里已有 `ResourceEmptyDiagnostic` 五态诊断组件与测试，但向导没复用 | P1 UI 复用缺失 |
| 4 | 预览等待长且无进度 | 预览路由**串行**逐关键词搜索，且**完全绕过**资源搜索的 30 分钟缓存，只共用 60 秒限流器 ⇒ 每次预览都是一次全量真实搜索；第二次预览在 60 秒内必吃 429 | P1 性能与可用性 |
| 5 | 其它交互 | 全角逗号不切分、正则被逗号切碎、Esc 不关、脏表单点背景即丢、取消季的季集范围残留、非流式搜索路径漏用排毒过滤、两处「冷却天数」语义相反 | P2 若干 |

**一句话根因**：向导与详情页面板是同一个表单的两份手写实现（模板、chip、预设、切分、冷却文案各写一遍），重复是上述缺陷的共同上游。

---

## 2. 逐条根因（代码证据 + 本地复现）

### 2.1 模板保存：向导里根本不存在该功能（P0）

向导模板区只有两个控件（[subscription-modal-fields.tsx:263](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-fields.tsx#L263) 起）：

- `选择已保存模板` 下拉 + `应用模板` 按钮

没有保存/更新/删除。完整 CRUD 在另一个组件（[subscription-policy-panel.tsx:241](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel.tsx#L241) 起），而它只挂在作品详情页（[show/[tmdbId]/page.tsx:313](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/show/%5BtmdbId%5D/page.tsx#L313)），且仅当 `canManageMedia` 时渲染。

因此向导用户（尤其是新用户，模板库为空）进入了一个「只能选、不能建、且库里没东西」的死区。服务端 `GET/POST/PUT/DELETE /api/titles/subscription-policy/templates` 全部就绪（[templates/route.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/templates/route.ts)，含 50 个/账号上限、按账号隔离），**后端不缺能力，缺的是向导的入口**。

### 2.2 即使调详情页也 400：优先级组 ID 超长（P0）

- 客户端生成：[subscription-policy-panel-model.ts:47](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.ts#L47) — `id: group_${crypto.randomUUID()}`
- 服务端校验：[subscription-policy-validation.ts:18](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/subscription-policy-validation.ts#L18) — `/^[\w-]{1,40}$/`

本地复现：

```
group_ + UUID 长度 = 42 → 校验 false
```

也就是说：**只要草稿里加了任意一个优先级组**，PUT 保存策略与 POST 保存模板都会 400（`第 N 组名称或 ID 无效`）。用户看到的「无法保存」在多数情况下是这个，而不是 2.1。

同源噪声：`Date.now()` 兜底路径的 ID 是 `group_<时间36>_<随机8>`（恰好 41–43 字符，也不稳定通过），测试断言的是该兜底格式（[subscription-policy-panel-model.test.ts:43](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.test.ts#L43)），**测试与生产路径的 ID 形状不一致**，所以这个 bug 在测试里永远测不出来。

### 2.3 默认 `简中字幕` 与归档执行语义冲突（P0 默认值）

三处默认值都含「简中字幕」：

- 向导初始草稿 [subscription-modal.tsx:148](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L148)
- 1080p 预设 [subscription-modal.tsx:78](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L78)
- 药丸 chip [subscription-modal-fields.tsx:21](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-fields.tsx#L21)

而匹配语义见 [subscription-policy.ts:300](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L300)：每个 `mustContain` 词都是 `name.toLowerCase().includes(term)`，**AND 关系**。

仓库内已有三份相互印证的「资源标题词汇」实测：

- [search-profile.ts:84](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/search-profile.ts#L84)：中文资源站电影命名用 `CHS-ENG`/`CHS`/`中英双字`/`双语`/`简繁`，**不写「中字」**；
- [sandbox.ts:644](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/sandbox.ts#L644)：`+1080p`/`+中字` 拼进关键词会把召回打成子集或归零（实测 铁拳教育 84→0、奥本海默 185→0）；
- [deterministic-selector.ts:70](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/deterministic-selector.ts#L70)：字幕加分识别的是 `内嵌/中字/简繁/双语`，**单靠「简中字幕」四字连写匹配不到它们**。

结论：默认预设 = `1080p AND "简中字幕"`，而「简中字幕」四字连写在实际标题中出现率极低（本仓三处实测注解均指向 `CHS`/`简繁`/`双语`/`中字` 这类写法），因此这条 AND 条件在多数真实标题上恒 false。用户在预览里看到「命中 0」，第一反应是「这部片没有资源」，而事实是**默认规则把一切排掉了**。这与文档 [movie-detail-…spec.md:199](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/movie-detail-workspace-resolution-and-modal-subscription-policy-spec.md#L199) 里写的「`mustContain: ["1080p","简中字幕"]`」一致——spec 本身就没与实际命名对齐。

同时注意一个既有的事实：本仓已有**两套互不相干的字幕词表**。搜索关键词剥离表 [QUALITY_SUBTITLE_TOKEN](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/snapshot-presentation.ts#L14) 覆盖 `4k|2160p|1080p|720p|hdr|dv|remux|web-dl|bluray|bdrip|蓝光|中字|国语|双语|字幕`；Agent 侧当选版加分识别的是 `内嵌|中字|简繁|双语`（[deterministic-selector.ts:70](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/deterministic-selector.ts#L70)）。两张表都没有 `简中`、`CHS`、`简日` —— 而用户界面上摆放的恰好是「简中字幕」「简日内嵌」。所以策略层的字幕词表必须单独定义（见 5.5），既不能复用搜索剥离表，也不能沿用现有预设文案。

### 2.4 预览 0 结果无诊断（P1）

预览接口 [preview/route.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts) 的响应只有：

```
ok, searchedKeywords, total, matchedCount, excludedCount, matched[], excluded[{name,reason}]
```

缺三类诊断（都不是难事，数据都在）：

1. **源健康**：`provider.search` 的 snapshot 已带 `sourceHealth`（[pansou-provider.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/pansou-provider.ts) 返回 `sourceHealth`），预览路由把它丢了；
2. **未上映**：预览解析出了 tracked/catalog title，`MediaTitle.releaseDate` 就在手上（[domain.ts:125](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/domain.ts#L125)），但它没有参与诊断；
3. **「0 命中」的两种来源无法区分**：`total=0`（没搜到）与 `total>0 && matched=0`（规则太严）在 UI 上只有一句「命中 0 个」，没有「这条规则排掉了全部候选」「源不可用」「未上映」「关键词被捆太窄」的主次引导。仓库里 `ResourceEmptyDiagnostic`（[resource-empty-diagnostic.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-empty-diagnostic.tsx)）已经实现了 streaming/unreleased/source_error/over_constrained/none 五态（含 9 个 SSR 测试 [resource-search-empty.test.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-search-empty.test.ts)），向导却只用 `preview.matchedCount>0 ? 列表 : 无输出`。

另外 `runPreview()` 用红色 `subscription-config-error` 显示「未能预览」类错误，成功的 0 结果则**什么都不显示**（[subscription-modal-view.tsx:257](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-view.tsx#L257)：`尚未生成预览。`）——用户点「预览效果」后，等待结束，界面几乎无声。

### 2.5 预览慢：串行搜索 + 绕过缓存（P1）

[preview/route.ts:230](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L230)：

```ts
for (const keyword of keywords) {
  const snapshot = await provider.search({ keyword });
  ...
}
```

三个结构性成本：

1. **串行**：关键词最多 4 个（[title-search-keywords.ts:23](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-search-keywords.ts#L23) `MAX_KEYWORDS=4`）。每个 keyword 在 PanSou 内部还要轮询：`maxSearchAttempts` 默认 4、`searchPollMs` 默认 2500ms（[pansou-provider.ts:234-235](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/pansou-provider.ts#L234)），第一次必等 2.5s。冷缓存下 4 个关键词串行 ≈ 10s 起步，服务端 2 个 in-flight 槽位（`MAX_IN_FLIGHT_PER_SERVER=2`）与 30s 槽位等待（[pansou-provider.ts:39-41](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/pansou-provider.ts#L39)）会进一步叠加。资源面板同样场景走**并发**（[title-resource-resolver.ts:110-125](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-resource-resolver.ts#L110) `Promise.all`），所以同一个检索在两个入口的耗时差一个数量级。
2. **绕缓存**：资源搜索有 `resourceCache`（30 分钟 TTL，[resources/cache.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/resources/cache.ts)），预览只 import 了 `resourceLimiter`（[preview/route.ts:12](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L12)）。于是**刚在详情页搜过的同一部片，预览还要重付一次全量搜索**。
3. **限流键跨请求共享**：预览用 `preview:${accountId}:title:${tmdbId}` 的 60 秒冷却；改完一次规则再点「重新预览」就必然 429「too many requests」（错误被文案化成 `预览失败`，用户以为是规则问题）。而且注意缓存已命中时资源路由**不消费冷却**（[title-resource-resolver.ts:80-97](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-resource-resolver.ts#L80)），预览却无条件先扣冷却——两套语义倒挂。

另有一个功能性不一致：预览**从不传 `seasonEpisodeRanges`**（`parsePreviewPolicy` 只解析 `priorityGroups`，[preview/route.ts:150](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L150)），而保存/巡检会用到它；预览对「逐季集数」的承诺是空的。同理预览用 `PolicyResource{name}`，不传 `episodeCode`，`requireSeasonEpisodeForRange` 也不开，与归档时 `seasonEpisodeRanges` 生效行为（[subscription-policy-filter.ts:54](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy-filter.ts#L54)）并不等价。

### 2.6 交互问题清单（第 5 问）

| 现象 | 代码 | 影响 |
| --- | --- | --- |
| 全角逗号不切分 | [panel-model.ts:221](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.ts#L221) `split(",")`；而 chip 追加逻辑用 `split(/[,，\s]+/)`（[subscription-modal.tsx:87](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L87)） | 用户输入「2160p，简中」变成一个词；本地已复现 |
| 正则里的逗号被切碎 | 同上 `split(",")` 与 `useRegex` 共存 | `S\d{2,3}` 变成 `S\d{2` + `3}` → 两侧都非法 → 全排 |
| 同一逻辑两处切分规则不同 | [panel.tsx:47](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel.tsx#L47) 与 panel-model 不一致 | 同一字符串在读回/编辑/保存三处形状不同 |
| Esc 不关闭 | 向导无 keydown 监听（对照 [acquiring-detail-modal.tsx:261](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/acquiring-detail-modal.tsx#L261) 有） | 键盘用户只能找 ✕ |
| 脏表单点背景即丢 | [subscription-modal-view.tsx:60](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-view.tsx#L60) 背景点击直接 `onClose` | 3 步填写全丢，无二次确认 |
| 取消选季但季集范围残留 | 范围键存于 `draft.seasonEpisodeRanges`（[subscription-modal-fields.tsx:488](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-fields.tsx#L488) 只增删不清） | 存回的 policy 含不可见季的区间；后续「全选」会突然生效 |
| 「冷却天数」两处语义相反 | 面板：[panel.tsx:455](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel.tsx#L455)「失败后暂缓重试天数」；向导：[modal-fields.tsx:392](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal-fields.tsx#L392)「巡检冷却天数」 | 真实语义是 patrol-scope 的「命中后 N 天不再取」（[patrol-scope.ts:119](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/patrol-scope.ts#L119)），两处文案都不对 |
| 优先级组添加/删除不可撤销且无空组校验 | [panel.tsx:490](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel.tsx#L490) | 空组按语义「跳过」，但 UI 不提示「和你写的规则将无一命中」，需要预览才看见 |
| 预览前无本地语法校验 | 只有服务端 400 | 需一次网络往返才知道 filter 写错 |
| 非流式资源搜索漏排毒 | [resources/route.ts:400](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/resources/route.ts#L400) 调用 `resolveTitleResources` 时没传 `filterPreferences`（第 382 行算出来只给了流式分支） | 同一资源列表在导航/脚本路径与面板路径不一致 |
| 详情页保存后 `enabled` 语义 | 面板 save 后 `router.refresh()` 但不提示「已排队任务不受影响」 | 与模板更新文案不一致（模板有该提示） |

---

## 3. 业界方案对照（第 2 问据实回答）

| 方案 | 关键行为 | 与本项目的取舍 |
| --- | --- | --- |
| [Sonarr Release Profiles](https://wiki.servarr.com/sonarr/settings) | `Required` / `Ignored` / `Preferred` 三组词，任一 Required 缺失即拒；Preferred 只加分不影响准入；对「词表」而非「字符串」 | 我们的 `mustContain` 相当于 Required、`mustNotContain` 相当于 Ignored；`priorityGroups` 近似 Preferred 但库里落到硬过滤（`priority_unmatched` 直接拒）。**建议把「必需→字面子串」与「优选→加分/排序」在 UI 上彻底分开**，默认预设只用画质词（`1080p`），字幕偏好改为「加分项 + 可关闭」。 |
| [Sonarr Custom Formats](https://wiki.servarr.com/sonarr/settings) | 格式是可复用的条件集合，多处引用同一份定义；改一处全生效 | 我们的「模板」其实就是 Custom Format 的简化版。应作为**唯一真源**（见 §4.1），向导与详情页只引用。 |
| [qBittorrent RSS rules](https://github.com/qbittorrent/qBittorrent) | `mustContain`/`mustNotContain`（每行一词）、`episodeFilter`（`S01-S03;E01-E10`）、`useRegex`、`Ignore subsequent matches for N days` | **本项目的字段名就是从它抄的**（[subscription-policy.ts:11](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L11) 注释明说）。它的两个已知痛点正好对应我们的第 3、5 问：正则不会被逗号切（每行一词）、冷却语义只有一个定义。 |
| [MoviePilot 优先级规则](https://wiki.movie-pilot.org/advanced) | 有序规则首条命中生效，配置后未命中即过滤 | 与 `priorityGroups` 完全同构；它的 UI 会把「规则改变后未命中 = 全部过滤」显式警告，我们缺的正是这句警告的主显位。 |
| [Prowlarr / Radarr 的搜索与预览](https://wiki.servarr.com/prowlarr) | 规则编辑与「Test」按钮分离，Test 结果只读、不落盘，可反复点 | 我们已遵循（preview 只读）。但它的 Test **带进度和逐源结果**，我们第 4 问要补的就是这层。 |
| [RE2 / re2-wasm](https://github.com/google/re2) | 线性时间正则，防灾难性回溯 | 见 [2026-11-06 既有调研](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/subscription-policy-execution-research.md)，结论是「候选而非已采用」。**本轮不需要**：`useRegex` 只在用户显式勾选时生效，且默认值单一；但要注意 §2.6 的「逗号切碎正则」比回溯更现实。 |
| [XState](https://stately.ai/docs/xstate) | 显式状态机 + actor，可序列化、可测试迁移 | **本仓已装**（`packages/workflow/package.json` 依赖 `xstate@5`），且已用在 [run-state-machine.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/run-state-machine.ts)。**不建议为向导 UI 引入 xstate**：向导的状态是 3 步 + 1 个可推导的 busy 集合，Reducer 足够；真正值得状态机化的是「预览/执行」的运行时（见 §4.4）。 |
| [TanStack Query / SWR](https://tanstack.com/query) | 客户端请求去重、缓存、失效 | 本仓未装，且本页数据本来就该走服务端缓存（`resourceCache`）。为第 4 问引入该库属于「用客户端缓存修服务端缓存缺口」，方向相反。**结论：不引入**。 |

---

## 4. 已有基础设施复用清单（第 3 问：零新增依赖）

逐项核对后，**本轮不需要新增任何 npm 依赖**：

| 能力 | 现成设施 | 位置 |
| --- | --- | --- |
| 模板持久化（按账号隔离、50 上限、CRUD + 测试） | `subscription_policy_templates` 表 + 仓储 + 4 个动词路由 | [sqlite-schema.ts:201](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite/sqlite-schema.ts#L201)、[sqlite.ts:2345](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/sqlite.ts#L2345)、[templates/route.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/templates/route.ts) |
| 判定核心（唯一匹配器，预览/巡检/归档共用） | `matchPolicy` / `previewPolicy`（纯函数，不读 DB 与时钟） | [subscription-policy.ts:341](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L341) |
| 资源搜索并发 + 去重 + 进度事件 | `resolveTitleResources` 的 `Promise.all` 与 `onChunk`（带 `progress.done/total/currentKeyword`） | [title-resource-resolver.ts:110](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-resource-resolver.ts#L110) |
| NDJSON 流式协议（服务端 + 客户端消费器） | `createResourceNdjsonStream` + `consumeResourceNdjsonStream` / `mapResourceStreamEvent`（后者是纯函数且有测试） | [resources/route.ts:217](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/resources/route.ts#L217)、[title-resource-panel.tsx:73](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/title-resource-panel.tsx#L73) |
| 空态五态诊断（含成员权限可达性） | `ResourceEmptyDiagnostic` + 9 个 SSR 测试 | [resource-empty-diagnostic.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-empty-diagnostic.tsx)、[resource-search-empty.test.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-search-empty.test.ts) |
| 结果缓存（30 min TTL，命中不耗冷却） | `TitleResourceCache` + `resourceCache` 单例 | [title-resource-cache.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-resource-cache.ts)、[cache.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/resources/cache.ts) |
| 限流（可读 `remainingMs` → `Retry-After`） | `CooldownLimiter.tryAcquire / remainingMs / reset` | [cooldown-limiter.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/cooldown-limiter.ts) |
| 多源并行 + 熔断 + 单飞去重 | `SearchProviderRegistry`（`parallel` + circuit + `inFlightSearches`） | [search-provider-registry.ts:175](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/search-provider-registry.ts#L175) |
| 标题解析（季集/字幕/画质） | `parseMediaTitleByName`（anitomy + parse-torrent-title + 中文字幕组兜底） | [media-title-parser.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/media-title-parser.ts) |
| 排毒过滤（负面词/容器/体积） | `applyAcquisitionFilters` + `DEFAULT_FILTER_PREFERENCES` | [acquisition-filter-pipeline.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/acquisition-filter-pipeline.ts) |
| 状态机基建 | `xstate@5` 已装且已在用 | [run-state-machine.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/run-state-machine.ts) |
| 校验基建 | `zod@4` 已装（当前仅 assistant 使用）；若干纯 `parse*` 函数 | [route.ts:87](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/route.ts#L87) |

真正缺失的只有一处：一个「草稿 → 请求体 → 面板态」的**共享层**，让向导与详情页面板消费同一份代码。这就是 §5.1 的适配器。

---

## 5. 方案设计

### 5.1 设计模式取舍（逐项判定）

| 模式 | 适合用在哪 | 不适合用在哪 | 本轮判定 |
| --- | --- | --- | --- |
| Adapter（适配器） | `PolicyDraft`（UI 字符串）↔ `SubscriptionPolicyWrite`（线上数组）↔ 模板 / 已存策略（读回） | — | 采用，见 5.2 |
| Strategy（策略） | ①「预设」= 一组可命名的规则构造器（1080p / 4K / 动漫 / 自定义）；②「预览取数」= 缓存优先 / 强制刷新两种策略 | 替换匹配器本身——`matchPolicy` 必须全局唯一，否则预览重新开始说谎 | 采用（限定范围），见 5.3 |
| State Machine（状态机） | ① 预览运行生命周期（idle→running→done / failed / throttled / aborted）；② 向导步进守卫 | 为「每条规则」建状态机（Sonarr / MoviePilot 都不这么做；[subscription-policy.ts:2](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L4) 的注释就是这条教训） | 采用（纯 reducer，不引 xstate），见 5.4 |

明确不做：

- 不引入通用规则引擎（json-rules-engine 之类）：规则只有 5 个字段，引入只会丢掉「预览与执行同一匹配器」这条不变量。
- 不为向导 UI 引 xstate：3 步守卫是一个纯函数 `canAdvance`；`xstate` 只在 workflow 包，引入 web 包会破坏既有依赖边界（[.dependency-cruiser.cjs:32](file:///E:/WorkProject/Node/_Project/mediary-scout/.dependency-cruiser.cjs#L32) 起的 L1 规则）。
- 不把字幕偏好做成 `mustContain` 的默认项（即第 2 问的修复方向，见 5.5）。

### 5.2 Adapter：一个共享 `policy-draft` 模块（P0 主体）

新建 `apps/web/features/acquisition/core/policy-draft.ts`（core 层纯净，满足 dependency-cruiser 的 `feature-core-stays-pure`），承担全部转换：

```
type DraftSource = "saved" | "template" | "preset" | "blank"
readDraft(source: {policy: unknown}) : PolicyDraft | null     // 现有 mapSavedPolicy 迁入
writeDraft(draft: PolicyDraft) : SubscriptionPolicyWrite       // 现有 draftToPolicy 迁入
normalizeTerms(raw: string, useRegex: boolean) : string[]        // 见 5.6 切分规则
makePreset(kind: PresetKind, base: PolicyDraft) : PolicyDraft    // 见 5.3
makePriorityGroup(seededId: string) : PolicyPriorityGroupDraft   // 见 5.2.1
```

- 向导的 [subscription-modal.tsx:104](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L104) `mergeLoadedPolicy`、[panel-model.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.ts) 的 `mapSavedPolicy/draftToPolicy`、详情页面板的 `appendFilterChip`/`toggleChipString` 三份实现全部改为调用它。
- 现有测试可直接指向新模块（[subscription-policy-panel-model.test.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.test.ts) 的断言保留，只是 import 改路径）。

#### 5.2.1 优先级组 ID（P0 修复）

- 生成：`makePriorityGroup()` 只用 `crypto.randomUUID()`，`group_` 前缀后可保留 12 位（`group_` + 12 = 18 字符），或干脆去掉前缀用 UUID（36 字符），都稳定落在 `^[\w-]{1,40}$` 内。
- 服务端把 `subscription-policy-validation.ts:18` 的正则放宽到 `{1,64}`（更稳妥，不依赖前端自觉），并保留长度上限。
- 兜底分支（无 `crypto.randomUUID` 的 HTTP 环境）生成等长 ID，且**测试改为断言两个生成器都 ≤ 40（或 64）字符**——现有测试只断言兜底形状，正好放过了生产路径的 bug（这是「测试与实际路径不一致」的典型，见 §7 门禁 G1）。

### 5.3 Strategy：预设与预览取数

预设改为「数据表 + 构造器」而不是 `if (preset === "4k")`：

```
const PRESETS: Record<PresetKind, { label: string; build(base: PolicyDraft): PolicyDraft }>
```

三个收益：向导与详情页面板共用同一份预设（现状是向导有 4 个预设（[subscription-modal.tsx:73](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L73)），详情页面板根本没有预设概念、只有 4 个 chip 预设（[panel.tsx:54](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel.tsx#L54)，且不含 `Remux`/`HDR` 与 `先行版`））；未来新增预设只改一处；预设可被测试。

预览取数策略（见 5.6 的接口改造）同样表驱动：`cache-first`（默认，命中即秒回）与 `refresh`（显式「重新搜索」，需冷却放行）。

### 5.4 State Machine：预览生命周期（不改后端语义）

把 `PolicyPanelState`（[panel-model.ts:65](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-policy-panel-model.ts#L65)）扩展成一个 reducer，事件即后端事件类型：

```
idle → previewing → streaming{progress} → ready{outcome+diagnostics}
                                        → failed{copy}
                                        → throttled{retryAfterMs}
任一 running 态 → aborted（用户关掉/换规则）
```

关键是 `aborted`：现状下用户改一个字段就把 `preview` 置 null（[subscription-modal.tsx:234](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/subscription-modal.tsx#L234)），但在飞的那次请求没人取消——返回后可能把「旧规则的命中数」贴到「新规则的表单」下（与 panel 里 `touchedRef` 防的是同一类竞态）。reducer 用 `requestId` 比较即可，无需 AbortController（更简单，但也可以顺手 abort 省配额）。

这也是第 4 问 UI 进度的落点：`streaming{progress}` 直接渲染 `已完成 x / y 个关键词（当前：关键字）`——**与资源面板的文案完全一致**（[resource-empty-diagnostic.tsx:43](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-empty-diagnostic.tsx#L43) 已实现该文案与测试）。

### 5.5 默认规则与字幕语义（第 2 问的核心修复）

**把「画质」与「字幕」拆成两类不同的东西**：

1. **画质 / 版本**（`1080p`、`2160p`、`Remux`、`HDR`）：这是硬约束，资源名几乎一定带，继续放 `mustContain`。
2. **字幕偏好**（简中 / 简日 / 内嵌 / 双语）：这是**软偏好**。同一部片带字幕的版本可能叫 `CHS`、`简繁`、`中英双字`、`[喵萌奶茶屋] … 简日双语`，也可能完全不标。

两条可选实现路径（推荐 A）：

**A. 新增 `subtitlePreference` 字段（推荐，最小侵入且语义正确）**

- `SubscriptionPolicyWrite` 增加可选 `subtitlePreference?: { require: boolean; terms: string[] }`。
- 默认 `terms = ["简中", "CHS", "中英", "简繁", "双语", "内嵌", "中字"]`（注意：这是**或**关系，任一词命中即视为有字幕）。
- `require: false`（默认）= 字幕只作为**排序加分 + 预览标注**，不参与准入；`require: true` = 在准入阶段加一条「任一字幕词命中」的 OR 组。
- `matchPolicy` 增加一个 step：`matchSubtitlePreference(policy, name)`，只在 `require` 为真时拒绝，否则只返回 `hasSubtitle` 供排序与展示。这一条同时补上一个真实缺口：现在「有字幕的版本排在无字幕版本前面」这件事，只有 Agent 侧评分在做（[deterministic-selector.ts:70](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/deterministic-selector.ts#L70)），策略层完全没有参与。

**B. 只改默认值（不新增字段）**

把三处默认的 `简中字幕` 改为不带字幕词的空规则（`1080p`），并删除「简中字幕」药丸，改为提示文案「字幕偏好暂由获取 Agent 自动择优」。这是 10 行改动，但会让「我要中文字幕」这个需求失去可配置入口。

无论走哪条，**`1080p` 预设本身必须去掉字幕词**——这是第 2 问的直接答复：能去除，而且应该去除。另外 `2160p, Remux`（4K 预设）同样过严：`Remux` 与 `2160p` 是 AND，而真实 Remux 资源常标 `BluRay.REMUX.UHD`（不含 `2160p` 字样），建议 4K 预设用 `["2160p"]` 或 `["2160p","4k","uhd"]` 的 OR 组。

### 5.6 预览接口改造（第 3、4 问）

目标：**预览与详情页搜索共用一个取数路径、一个流协议、一份诊断。**

```
POST /api/titles/subscription-policy/preview?stream=1
  body: { tmdbId, mediaType, seasonNumbers[], policy, refresh?: boolean }
  → NDJSON:
     { type:"chunk", newCandidates, allCandidates, progress:{done,total,currentKeyword} }
     { type:"done",  searchedKeywords, total, matchedCount, excludedCount,
                     matched[], excluded[{name,reason}],
                     sourceHealth, releaseDate, cached }
     { type:"error", kind:"throttled"|"error", retryAfterMs?, message }
```

实现要点（全部复用现有件）：

1. **复用 `resolveTitleResources`**，而不是手写 `for … await`。它已经做了 `Promise.all` 并发 + 按 `candidateId` 去重 + `onChunk` 进度 + `sourceHealth` 汇总。预览只需在其后接一次 `previewPolicy(parsed.policy, resources)`，并保留 `resolveTitleResources` 的缓存与冷却语义（**cache 命中不扣冷却**，与资源路由一致，消除 2.5 的语义倒挂）。
2. **冷却键统一**：改为复用 `resourceLimiter` 的 `TitleResourceCache.key(accountId, String(tmdbId))` 同基键（或其 `:refresh` 后缀），让「详情页搜过 → 顾问预览」是一次缓存命中，而不是第二次付费搜索。若用户显式点「重新搜索」，传 `refresh: true` 走 cooldown 分支并回带 `retryAfterMs`。
3. **补齐被丢掉的字段**：`parsePreviewPolicy` 增加 `seasonEpisodeRanges`、`customKeywords`，`previewPolicy` 调用时对 `PolicyResource` 尽量带上 `episodeCode`（可用现成的 `parseMediaTitleByName` 从标题抽取 `SxxEyy`），使预览与归档语义一致（当前两者不等价，见 2.5）。
4. **诊断字段**：`done` 事件带 `sourceHealth`（取自 snapshot）与 `releaseDate`（取自已解析的 title），前端复用 `ResourceEmptyDiagnostic` 的五态判定（它已是纯函数式、有 9 个测试，只需喂数据）。
5. **429 有话说**：把 `"too many requests"` 文案改为「预览太频繁，N 秒后可再试」，并回带 `retryAfterMs` / `Retry-After`（`CooldownLimiter.remainingMs` 现成）。
6. **兜底超时**：预览路由目前没有任何总时长上限。建议给整次预览一个 `Promise.race` 的绝对上限（例如 45s），超时返回 `kind:"error"`「检索超时，规则本身未保存」。这与仓库既有 `AbortSignal.timeout` 风格一致（[pansou-provider.ts:160](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/pansou-provider.ts#L160)）。

> 兼容性：`POST` 无 `stream=1` 时继续保持现有一发 JSON 响应，便于脚本与测试（既有 [route.test.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.test.ts) 不动）。

### 5.7 「0 命中」的诊断优先级（第 3 问的 UI 答复）

判定顺序（与资源面板一致，避免两套话术）：

```
1) sourceHealth ∈ unreachable/protocol_error → 源异常，不是没资源（指路 /settings，成员不可达则改为「联系站长」）
2) releaseDate 在未来 → 尚未上线，建议预定/追踪
3) total === 0 → 本次检索无候选（可能关键词过窄：展示实际用到的关键词数与前 3 个关键词）
4) total > 0 && matched === 0 && priorityGroups.length > 0 → 「优先级组未命中任何候选」→ 提供「清空优先级组」一键
5) total > 0 && matched === 0 → 「规则排除了全部候选」→ 按 reason 分组展示（最好前 3 条被排除的实际标题 + 原因）
6) matched > 0 → 正常结果
```

第 4、5 条尤其是当前最缺的：截图场景（默认规则 + 「简中字幕」）恰好落入第 5 条，而屏幕只有下面那一小行灰字。

同时把「预计命中 N 个 / 共 M 个」升级为三段式：

- 准入通过 `matchedCount`
- 硬排除 `excludedCount`（按 reason 细分：词命中 / 缺必需词 / 集数越界 / 优先级未命中）
- 本次检索规模 `total` + `searchedKeywords`（并标注是否 `cached`）

### 5.8 向导交互修复清单（第 5 问的可执行条目）

| 修复 | 做法 |
| --- | --- |
| 模板 CRUD 进向导 | 抽出 `PolicyTemplateTools`（向导/详情页共用一个组件），带「保存当前规则为模板 / 用当前规则更新 / 删除 / 应用」四按钮；空库时显示「还没有模板，先保存一个」 |
| 切分规则统一 | `normalizeTerms`：非正则模式按 `/[,，、;；\s]+/` 切；正则模式**整行一个表达式**（换行分隔），并提示「正则模式下每行一条」 |
| 本地校验 | `validateDraft(draft)` 用现有 `parseEpisodeFilter`（纯函数）与正则编译 `try/catch`；错误就地红框，不发给服务端 |
| Esc 关闭 | 复制 `acquiring-detail-modal` 的 keydown 写法，但**有脏改动时先确认** |
| 背景点击保护 | 脏表单时背景点击/关闭按钮改为确认「放弃未保存的规则？」（复用 `AppConfirmDialog`，gate 已禁止原生 confirm） |
| 取消选季时清理范围 | `onToggleSeason(false)` 时同步 `seasonEpisodeRanges.filter(r => r.seasonNumber !== n)` |
| 冷却文案 | 两处统一为「巡检冷却：命中后 N 天内不再获取新版本」。若确需失败重试语义，另立 `retryBackoffDays` 字段，不要复用同一字段 |
| 非流式搜索排毒 | [resources/route.ts:400](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/resources/route.ts#L400) 补传 `filterPreferences`，与非流式/流式两条路径对齐 |
| 空优先级组提示 | 组内全空时灰字标注「该组将被跳过」；若全部组为空且长度为 0，不启用 `priority_unmatched` 判定 |

---

## 6. 性能与可行性评估

| 维度 | 现状 | 改后预期 | 依据 |
| --- | --- | --- | --- |
| 预览首次延迟（冷缓存，4 关键词） | 串行 ≈ 4 × (2.5s 轮询起步 + 上游) ≈ 12–20s | 并发 ≈ 1 个关键词的耗时（约 3–6s）+ PanSou 2 槽位排队 | 复用 `Promise.all`（[title-resource-resolver.ts:110](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-resource-resolver.ts#L110)） |
| 预览二次延迟（60s 内） | 必然 429 | 缓存命中 < 200ms | 复用 `resourceCache`（TTL 30 min） |
| 与详情页搜索的重复成本 | 各付一次全量检索 | 共享一次 | 统一冷却/缓存键 |
| 上游预算 | 预览不受 TTL 约束 | 受 30 min TTL 约束，最多与手动搜索等价 | 与 plan §3.2 的预算模型一致 |
| 首屏进度反馈 | 无 | 每个关键词完成即推一行 NDJSON | 复用 `onChunk` + 现成消费器 |
| 极端兜底 | 无总时长上限 | 45s 硬超时 | `AbortSignal.timeout` 同风格 |

风险与缓解：

- **重复检索打穿上游**：改为 cache-first 后，`refresh` 必须显式且受限流约束（同一 `(account,title)` 60s），不会比现状更贵。
- **NDJSON 在 preview 上的 Next 兼容**：资源路由已在用同一套（`application/x-ndjson`），无新平台风险。
- **`subtitlePreference` 属契约新增**：本仓明确「未正式发布不做历史兼容」（见 [project-no-historical-compat]）；但已有库内 policy JSON 是宽松存储（`payload`），读回时缺该字段按默认处理即可，无需迁移脚本。
- **策略快照**：任务入队快照会跟着新字段走（现有 `SubscriptionPolicyWrite` 直接序列化），不会出现「快照缺字段」的失败关闭问题。

---

## 7. 门禁与回归测试（防同类回归）

| ID | 门禁 | 类型 | 断言 |
| --- | --- | --- | --- |
| G1 | 优先级组 ID 生成器长度 | 单测 | `makePriorityGroup()` 与兜底生成器的输出都匹配服务端正则（`scripts` 里的正则常量共享，避免两端漂移） |
| G2 | 草稿往返不变 | 单测（属性式） | 对任意 `PolicyDraft`，`readDraft(writeDraft(d))` 的 term 集合等价；全角逗号/顿号/分号/换行都切成同一组词 |
| G3 | 默认预设不杀召回 | 单测（语料驱动） | 用仓库内已有的真实标题样本（`user-message-thread.test.ts` 里的 `[喵萌奶茶屋] 黄泉的使者 13 [1080p][简日双语]` 等）断言：默认 1080p 规则至少命中该类标题 ≥ 1；「简中字幕」四字连写不再出现在任何默认/预设中 |
| G4 | 预览与执行同一判定 | 单测（对偶式） | 对同一批资源，`previewPolicy` 的 counts 必须等于逐个 `matchPolicy`；且 `seasonEpisodeRanges` 参与后仍一致 |
| G5 | 预览不重复付费 | 集成测试 | 先调用 `/api/titles/resources` 再调用 `preview`，断言预览命中缓存（`cached: true` 且 provider `searchCalls` 不增加） |
| G6 | 诊断优先级 | 组件测试（SSR，沿用现有写法） | 五种空态按 5.7 的顺序命中，且成员（无 `system:settings`）不渲染 `/settings` 死链 |
| G7 | 脏表单保护 / Esc / 范围清理 | 组件测试 | 背景点击 + 脏表单不触发 `onClose`；取消选季后 `seasonEpisodeRanges` 不含该季 |
| G8 | 门禁脚本（静态） | `tools/gates` 新增检查 | 禁止策略词汇（正则在 `useRegex` 下）再被逗号切分：`apps/web/features/acquisition` 内禁止 `split(",")` 直接用于 term 解析；模板 CRUD 必须只有一处实现（`PolicyTemplateTools`），向导与面板不得各写一份 fetch |

G8 是「同类问题」的根治：现有缺陷全部来自「同一逻辑两份实现」与「两端常量各写一份」。

---

## 8. 实施顺序（建议分批，每批可独立验证）

1. **P0-A 契约修复（最小改动，先解锁保存）**：优先级组 ID 生成 + 服务端正则放宽；`normalizeTerms` 统一切分；补 `filterPreferences` 到非流式路径。测试：G1/G2。
2. **P0-B 共享适配层**：新建 `policy-draft`（Adapter + PRESETS Strategy），向导与详情页改为消费它；删除两份重复实现。测试：G2/G3。
3. **P0-C 模板四处动词进向导**：抽 `PolicyTemplateTools` 组件，两侧共用。测试：模板 CRUD 单测（现有 `templates/route.test.ts` 保留）。
4. **P1-A 预览取数与流式进度**：预览路由改用 `resolveTitleResources` + NDJSON + 缓存键统一；前端 reducer 状态机 + 进度条。测试：G4/G5。
5. **P1-B 空态诊断复用**：`done` 事件带 `sourceHealth`/`releaseDate`，前端复用 `ResourceEmptyDiagnostic`。测试：G6。
6. **P2 交互打磨**：Esc / 脏表单确认 / 范围清理 / 冷却文案 / 空组提示。测试：G7。
7. **默认值改字幕语义**：按 5.5 走 A 路径（新增 `subtitlePreference`）或 B 路径（仅改默认值），二者都可独立上线；若走 A，需要同步更新 [subscription-policy-execution-research.md](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/subscription-policy-execution-research.md) 的「目标语义」小节。

每批完成后的验收：

- `npm run build:workflow && npx vitest run <相关文件> && npm run typecheck && npm run lint`
- `npm run gate:contracts`、`npm run gate:parity`、`npm run gate:modals`、`npm run gate:limits`（新文件需低于 600 行/60KB）
- 浏览器实机（Dev 3020）：创建订阅三步走查 + 详情页策略面板 + 模板新建/应用/更新/删除 + 空态四种场景（源异常 / 未上映 / 规则过严 / 无候选）

---

## 9. 待确认事项

1. **字幕偏好走 A 还是 B**（§5.5）：A 语义正确但涉及契约与匹配器扩展（`matchPolicy` 新增一步、快照字段、巡检排序）；B 最小但删掉了可配置入口。当前倾向 A，且 `require` 默认 false。
2. **「重新预览」是否允许绕过 60s 冷却**：建议不允许（防上游打穿），但要在 UI 上显示剩余秒数而不是静默失败。
3. **向导是否需要在保存前强制跑一次预览**：现状是「点预览效果」才进第 3 步，若把预览做成流式秒回，可考虑在第 2 步末尾自动跑一次轻量预览（cache-first），让用户边改边看数字（对应 plan §4.1 的「规则预览是低成本的」原意）。
4. **模板是否需要「内置只读模板」**（如官方 1080p / 4K / 动漫三套，不可删只能复制）：Sonarr 的 Custom Format 社区做法；能让新用户开箱即用，避免空库死区。

---

## 10. 附：本次复现记录（可复核）

```
# 优先级组 ID
node -e "const u=require('crypto').randomUUID(); const id='group_'+u; console.log(id.length, /^[\w-]{1,40}$/.test(id))"
→ 42 false

# 全角逗号与正则切分
node -e "const s=v=>v.split(',').map(t=>t.trim()).filter(Boolean); console.log(s('2160p，简中')); console.log(s('S\\\\d{2,3}'))"
→ [ '2160p，简中' ]
→ [ 'Sd{2', '3}' ]

# 模板表存在但为空（本地 data/mediary.db）
subscription_policy_templates: 0 rows
subscription_policies: 0 rows
```

三项均与 §2 的结论一致：**后端设施齐备、前端入口与契约不一致造成「存不进 / 看不到」**。

---

## 11. 参考资料

- [Sonarr Settings（Release Profiles / Custom Formats）](https://wiki.servarr.com/sonarr/settings)
- [MoviePilot 优先级规则](https://wiki.movie-pilot.org/advanced)
- [qBittorrent RSS 规则实现](https://github.com/qbittorrent/qBittorrent)
- [Prowlarr / Radarr Wiki](https://wiki.servarr.com/prowlarr)
- [XState 文档](https://stately.ai/docs/xstate)
- [TanStack Query](https://tanstack.com/query)
- 本仓既有调研：[订阅策略配置与执行方案](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/subscription-policy-execution-research.md)、[多季度追踪与集数范围优化](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/season-episode-tracking-design.md)、[搜索页与资源查询加载速度调研](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/research/search-page-resource-query-performance-investigation-2026-11-05.md)、[作品详情与订阅策略规格](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/movie-detail-workspace-resolution-and-modal-subscription-policy-spec.md)


---

## 12. 实施记录（2026-11-16 本轮）

### 12.1 落地的代码

| 新增/改动 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `apps/web/features/acquisition/core/policy-draft.ts` | 草稿 ⇄ 线上 ⇄ 模板的唯一转换层；`PRESETS` 策略表；`splitTerms`（全角逗号/顿号/分号/空白 + 正则按行）；`makePriorityGroup`（`group_` + 12 位，≤64）；`validateDraft` 本地预检 |
| 新增 | `apps/web/features/acquisition/core/policy-preview.ts` | 预览状态 reducer（含 `invalidated` / requestId 防迟到覆盖）、`mapPreviewResponse`、`previewHeadlineCopy`、`diagnoseEmptyPreview` 六级判定 |
| 新增 | `apps/web/features/acquisition/core/preview-stream.ts` | NDJSON 预览事件消费（progress / done / throttled / error） |
| 新增 | `apps/web/features/acquisition/components/policy-template-tools.tsx` | 模板 CRUD 唯一实现（保存/更新/删除/应用），向导与详情页共用 |
| 新增 | `apps/web/lib/subscription-policy-validation.ts`（重写） | 优先级组 ID 上限 64、字幕偏好校验（`require` + 空词表 ⇒ 400） |
| 新增 | `apps/web/lib/subscription-policy-season-ranges.ts` | 逐季集数范围的唯一语法（保存与预览共用） |
| 新增 | `apps/web/app/api/titles/subscription-policy/preview/drive-provider.ts` | 预览取数的网盘品牌解析（全局工作区 → 默认 115） |
| 重写 | `apps/web/features/acquisition/components/subscription-modal.tsx` | 消费共享层；`?stream=1` 进度；`latestRequestRef` 作废旧结果；取消季度清理范围；`validationRequested` 门控 |
| 重写 | `apps/web/features/acquisition/components/subscription-modal-view.tsx` | Esc 关闭 + `AppConfirmDialog` 脏表单守卫；逐季范围/字幕/诊断渲染 |
| 重写 | `apps/web/features/acquisition/components/subscription-modal-fields.tsx` | `ChipTermField` / `SubtitlePreferenceField` / `AdvancedPolicyFields` / `PriorityGroupsSection` / `PreviewStatusCard` 拆分（复杂度回到预算内） |
| 重写 | `apps/web/features/acquisition/components/subscription-policy-panel.tsx` | 与向导共用 `policy-draft` + `PolicyTemplateTools`；预设按钮、字幕偏好、诊断、本地校验 |
| 删除 | `subscription-policy-panel-model.ts` / `.test.ts` | 被 `core/policy-draft.ts` + 新测试取代（「同一逻辑两份实现」的直接清除） |
| 重写 | `apps/web/app/api/titles/subscription-policy/preview/route.ts` | 改用 `resolveTitleResources`（并发 + 30 分钟缓存 + 冷却）；NDJSON；45s 硬超时；429 带 `retryAfterMs`；补齐 `seasonEpisodeRanges`/`customKeywords`/`subtitlePreference`；同名去重 |
| 改 | `apps/web/app/api/titles/subscription-policy/route.ts` | 保存路径接入字幕偏好校验与共享集数语法 |
| 改 | `apps/web/app/api/titles/resources/route.ts` | 非流式路径补 `filterPreferences`（与流式同一份列表） |
| 改 | `packages/workflow/src/execution/subscription-policy.ts` | 新增 `SubtitlePreference` / `DEFAULT_SUBTITLE_TERMS`；`matchPolicy` 增加字幕步骤（仅 `require` 时拒）；`previewPolicy` 返回 `matchedWithSubtitleCount` |
| 改 | `packages/workflow/src/execution/subscription-policy-filter.ts` | `rank` 加入字幕次序（仅在配置了字幕词时生效），不改变无字幕用户的次序 |
| 改 | `packages/workflow/src/persistence/{subscription-policy-store,sqlite,sqlite-schema,repository}.ts` | `subtitle_preference` 列（含 ALTER 补列）、读写、任务快照透传 |
| 新增 | `tools/gates/check-policy-single-source.mjs`（`npm run gate:policy`） | 五条静态契约：禁止重复切分/模板 CRUD 单实现/转换函数单源/ID 长度/禁止字幕硬条件 |

### 12.2 门禁与测试结果

- `npm run gate`（含新增 `gate:policy`）**exit 0**；depcruise 1589 模块零违规。
- `npx vitest run apps/web packages/workflow/tests`：**504 文件 / 5641 用例全绿**。
- 新增测试：`core/policy-draft.test.ts`（30 例，覆盖 G1/G2/G3/G4/G6/G7 + reducer）；preview 路由 27 例（含「同名只算一个」与「缓存命中不扣冷却 / refresh 仍受限速」）；workflow 侧补字幕排序用例。
- `npm run build:workflow` / `tsc --noEmit`（web + workflow）/ `npm run lint` 全通过。

### 12.3 Dev 实机验收（开发实例 3020 端口，生产 3000 端口未动）

用内置浏览器（结构快照 + 脚本驱动）逐项验证：

| 项 | 结果 |
| --- | --- |
| 向导第 2 步模板区 | 出现「应用模板 / 用当前规则更新模板 / 删除模板 / 保存当前规则为模板」四按钮，空库显示「还没有模板」 |
| 带优先级组保存模板 | 填名 + 加组（组名/2160p）后保存 ⇒ `模板已保存`，下拉出现该模板并选中（此前必 400） |
| 删除模板 | `模板已删除；已应用的规则不受影响`，下拉回到空态 |
| 默认规则 | `必须包含 = 1080p`、`必须排除 = CAM/枪版, 预告片`，字幕显示「中字优先（不强制）」，词表含 `简中/简日/CHS/简繁/双语/中英/中字/内嵌/字幕`——「简中字幕」硬条件已不存在 |
| 预览进度 | 点「预览效果」后实时出现「正在检索 2 / 3 个关键词（当前：野兽之心）」 |
| 预览结果 | 第二次起「（缓存结果）」；重复同名候选被合并（24 → 17 条） |
| 0 命中诊断 | 把包含词改成不存在的词 ⇒ 显示「这条规则排除了全部候选——检查一下是不是写得太严」 |
| 本地校验 | 集数填「第一季」时**打字途中不报错**，点「预览效果」后才就地提示「集数写法看不懂…」并停在策略步 |
| 脏表单守卫 | 第 2 步点 ✕/Esc 弹出「放弃未保存的订阅设置？」；「继续编辑」留在弹窗，「放弃并关闭」才关闭 |
| 详情页策略面板 | 预设按钮 4 个（带 title 说明）、模板工具、字幕偏好、诊断与 `命中 N 个，排除 M 个（…N 个带中文字幕）（缓存结果）` 文案均按新契约渲染 |

未覆盖：真实转存/写入链路（本轮只改策略配置与预览读侧）、移动端窄屏（Dev 环境无移动视口可视面）。

### 12.4 与方案的偏差（据实记录）

1. 字幕偏好按方案 §5.5 **A 路径**实施（新增 `subtitlePreference`，`require` 默认 false），并额外让 `rank` 在配置了字幕词时把有字幕的排前。
2. 预览的「refresh」用 `cacheKeySuffix` 实现：显式刷新走不同缓存键，但仍受同一 60s 限流器约束（方案 §9 待确认项 2 的选择）。
3. 预览结果额外做了**同名去重**（方案未写，实机发现 24 条里有重复名字），否则「命中 N 个」不是用户眼里的 N。
4. 向导的校验错误改为「点击继续后才显示」——方案没写这一条，实机发现打字途中报红会打断输入。
