# 预览「命中 137 个」的假阳性：规则只验表层词，从不验「是不是这部作品」

- 日期：2026-11-17
- 状态：调研完成，方案待实施（含门禁 G9–G11）
- 触发现象（创建订阅 → 第 3 步「预览与确认」，作品《12 12 12》）：
  - 「命中 **137** 个，排除 158 个，共检索 295 个候选（其中 13 个带中文字幕）」
  - 然而命中清单里前 5 条是 **《给你宇宙》《法警小队》《中央情报局》《汪汪队立大功》《法律与秩序：特殊受害者》** —— 五部完全不相干的剧。
  - 被「排除」的里面有《一人之下》《庆余年》《半泽直树》—— 也全是别的作品。
- 性质：只读源码审计 + 本地确定性复现（用仓库内真实解析器跑截图里的标题）；未改代码。

---

## 1. 结论先行

**不是匹配器写错了，是匹配器根本没有「身份」这一环。**

`matchPolicy` 只回答「这条资源的**标题文本**满足这些包含/排除/集数/优先级条件吗」，它从来不看「这条资源是不是**这部作品**」。所以一条只写 `1080p` 的规则，对全网任何一部 1080p 的剧都返回 `matched: true`：

```
规则：mustContain=["1080p"], mustNotContain=["CAM/枪版","预告片"], 第1季 E01 起
给你宇宙 (2026) 第1季 全12集 1080P ...      → matched: true
法警小队.2026 - S01E12 - ... 1080p ...      → matched: true
中央情报局.2026 - S01E12 - ... 1080p ...    → matched: true
汪汪队立大功.2013 - S12E12 - ... 1080p ...  → matched: true
法律与秩序：特殊受害者.1999 - S27E12 - ...  → matched: true
```

（上面是本地实跑结果，不是推演：`node` 加载 `packages/workflow/dist`，用 `matchPolicy` + 截图里逐字标题。）

「命中 137 个」的真实含义因此是 **「全网有 137 条 1080p 且不含 CAM/预告片的资源」**，与《12 12 12》毫无关系。这是一个**假阳性召回**，而且是最糟的一类：它让人以为规则很好、片源很足，真去获取时才会在「转存了别的剧」上暴露。

另外截图暴露了同一族的第二、三个问题（都在同一层）：

2. **季包被当成一条**：`给你宇宙 第1季 全12集` 是一个 12 集的整季包，计数算 1；而单集也被算 1。所以「命中 N 个」这个数在不同候选粒度之间**没有可比性**，用户无法判断这 137 条到底意味着「137 集」还是「137 个不同作品」。
3. **同名不同年/不同作品的误判**：`野兽之心` 与 `野兽 (2024)`、`美女与野兽` 等名字相近但不同作品，规则同样只看词有没有出现。

---

## 2. 根因：匹配器缺一层「作品身份闸门」（代码证据）

### 2.1 `matchPolicy` 的输入里没有身份

```ts
export interface PolicyResource {
  name: string;              // 只有显示名
  episodeCode?: string | null;
}
```

[subscription-policy.ts:23](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L23)

`MatchPolicyOptions` 只有 `requireSeasonEpisodeForRange` 一个开关（[:325](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L325)），同样没有身份。

### 2.2 `matchPolicy` 的判定顺序里没有「这一步」

[subscription-policy.ts:400](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy.ts#L400) 依次跑：`matchPolicyTerms`（包含/排除词）→ `matchSeasonEpisodeRanges` → `matchEpisodeFilter` → `matchSubtitlePreference` → `matchPriorityGroup`。全部都是**表层文本**条件，没有一步问「这是不是《12 12 12》」。

### 2.3 三个调用点都只传名字

| 调用点 | 代码 | 后果 |
| --- | --- | --- |
| 巡检/获取（agent 之前） | [real-provider-adapter.ts:140](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/real-provider-adapter.ts#L140) `accept({ name: candidate.title, episodeCode: null })` | 别的剧的 1080p 资源会被交给 agent 当候选 |
| 策略过滤器装配 | [subscription-policy-filter.ts:42](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/subscription-policy-filter.ts#L42) `accept: (candidate) => matchPolicy(matcher, candidate).matched` | 同上；而且**装配它的地方手里就有 `input.title`**（[runner-v2.ts:86](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/runner-v2.ts#L86) 传的是 `titleKey`），只是没把身份传给匹配器 |
| 规则预览 | [preview/route.ts:305](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L305) `previewPolicy(parsed.policy, resources)` | 预览**已经解析出 `title`**（[:259](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L259)），但只把名字喂给 `policyResourceFromTitle`（[:127](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L127)），身份在这一步被丢掉 |

也就是说：**身份数据一直在手上，只是没进入判定。** 这不是「算错了」，是「压根没算」。

### 2.4 规则本身的设计缺口

`mustContain` 的语义在业界是「在**已确认是这部作品**的资源里再筛掉不适合的版本」（Sonarr 的 Required/Ignored、qBittorrent 的 must contain 都是在匹配到目标之后）。本仓把它当成了「唯一的准入条件」，于是用户只填 `1080p` 时，规则等于「全网任何 1080p」。见 §3。

---

## 3. 业界方案对照

| 方案 | 判定顺序 | 与本仓的差距 |
| --- | --- | --- |
| [Sonarr](https://wiki.servarr.com/sonarr/settings) | ① 用 Release Parser 解析发布名 → ② **先按 series 标题 / 别名 / scene mapping 判断这是不是该剧（含年份作为消歧）** → ③ 再套 Release Profile（Required / Ignored / Preferred）。不是该剧的发布**根本进不了②之后的阶段** | 我们把 ①② 整段跳过了，直接从③开始 |
| [Radarr](https://wiki.servarr.com/radarr/settings) 同名电影 | 用 `title + year` 做身份，同名不同年靠年份分开；「must contain」只在身份通过后生效 | 同上；且本仓的 `MediaTitle` 已有 `year` / `originalTitle` / `aliases` / `tmdbId` 四件套，没用上 |
| [Sonarr 的 scene mapping](https://forums.sonarr.tv/t/sonarr-search-should-properly-handle-year-in-release-title/29924) | 发布组经常不用标准名，靠映射表把「别名 → 正式名」补上 | 本仓 `aliases` 字段存在但**从不参与匹配**（只在关键词阶梯里用过一次：[title-search-keywords.ts:109](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/title-search-keywords.ts#L109)） |
| [MoviePilot 订阅](https://wiki.movie-pilot.org/advanced) | 订阅先绑定 TMDB 条目，搜索结果的标题/年份要与绑定条目一致，之后才是优先级规则 | 同 Sonarr：身份在前，规则在后 |
| [Prowlarr](https://wiki.servarr.com/prowlarr) | 只负责「搜」，不负责「判断是不是这部」；判断留给 Sonarr/Radarr | 印证职责切分：**搜索层不该兼任身份判定** |

**可借鉴的关键点**：身份判定必须是一个**独立的、先于所有版本词的前置闸门**，而不是再往 `mustContain` 里加词。往规则里加片名只会让用户每次都手写一遍片名，并且换个译名就失效。

---

## 4. 当前系统已有的基础设施（无需新增依赖）

复核后**零新增 npm 依赖**，需要的能力全在仓库里：

| 能力 | 现成件 | 位置 |
| --- | --- | --- |
| 发布名解析（标题 / 年份 / 集号 / 画质 / 字幕组） | `parseMediaFileName`（anitomy + parse-torrent-title + 中文层三路合并） | [media-title-parser.ts:112](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/providers/media-title-parser.ts#L112) |
| 标题归一化（去括号组/体积/发布噪声/标点/大小写） | `normalizeResourceLabel` | [user-requests.ts:260](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/user-requests.ts#L260) |
| 去年份与 `{tmdb-N}` 后缀 | `cleanMediaTitle` | [episode-code.ts:114](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/episode-code.ts#L114) |
| `{tmdb-N}` 精确识别 | `tmdbIdFromMediaLibraryFolderName`（正则形状可直接复用） | [media-library-folder.ts:20](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/media-library-folder.ts#L20) |
| 目标作品的四件套身份 | `MediaTitle.title / originalTitle / aliases / year / tmdbId` | [domain.ts:109](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/domain.ts#L109) |
| 拒绝原因 → 用户文案的既有映射 | `PreviewExcludeReason` / `previewReasonCopy` | [policy-preview.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/core/policy-preview.ts) |
| 审计事件（过滤统计） | `filterAuditEvent` + `policyReasons` 计数 | [real-provider-adapter.ts:154](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/real-provider-adapter.ts#L154) |

**不要用的**：`fast-levenshtein` 只作为 eslint 的 `optionator` 传递依赖存在，业务代码引用它属于「借用别人的间接依赖」，违反本仓既有约定；`fuse.js` / `string-similarity` 未安装且不需要——身份判定用「归一化标签包含 + 词元重叠 + 年份/ID 校验」就够，且完全可测。

---

## 5. 方案：加一层「作品身份闸门」（Identity Gate）

### 5.1 判定位置：`matchPolicy` 的第一步，先于任何版本词

```
matchIdentity(title, resource)  ← 新增，最先执行
  ├─ 解析：parseMediaFileName(resource.name)
  ├─ 硬锚点 ①：标题里出现 {tmdb-N} 且 N ≠ 目标 tmdbId  ⇒ reject "wrong_title"
  ├─ 硬锚点 ②：解析出年份且与目标年份相差 > 1     ⇒ reject "wrong_title"
  ├─ 主判定：归一化后的候选标题 ⊇ 目标片名（title / originalTitle / aliases 任一）
  │          或 词元重叠 ≥ 阈值（应对「指环王：力量之戒」这类含冒号/副标题的名字）
  └─ 全不通过 ⇒ reject "wrong_title"
```

要点：

1. **硬锚点优先**：截图里那几条带 `{tmdb-290856}` 的资源，一条就否掉——它们的 tmdb id 与《12 12 12》不同。这是最便宜、最不容易出错的信号，应放在最前面（且 `{tmdb-N}` 只在**明确解析到**时才当锚点，解析不到不否决）。
2. **年份只做否决、不做准入**：缺年份的资源不能被拒（大量资源不带年份，见 [search-profile.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/acquisition-v2/search-profile.ts) 的实测：加年份常把召回打零）；年份**冲突**才拒。
3. **别用「必须完全相等」**：`12 12 12 S01 1080p` 解析出来的标题是 `12`（anitomy 截断），严格相等会把真资源也拒掉。用「归一化后包含 + 词元重叠」的双轨，容忍副标题与截断。
4. **一个特例要显式处理**：纯数字/极短片名（如 `12 12 12`）的词元重叠天然很高，**必须要求归一化包含（而非仅重叠）**，否则数字会与别处的数字撞上。这条已本地复现：`12 12 12 S01 1080p` → 解析标题 `12` → 与 `121212` 不够，但 `121212` 作为子串在 `1212122026` 里成立——所以「包含」判定必须用**双向**：候选归一化包含目标，且候选里不能把目标切成孤立数字片段。

### 5.2 数据接入：三个调用点各拿一次身份

| 调用点 | 怎么拿到身份 | 改动 |
| --- | --- | --- |
| 策略过滤器 | `loadSubscriptionPolicyFilter` 增加 `title: MediaTitle` 入参（[runner-v2.ts:86](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/execution/runner-v2.ts#L86) 手上已有 `input.title`） | 装配时构造一次 `TitleIdentity`，`accept/rejectReason/rank` 都带上它 |
| agent 前的适配器 | 同上，从 filter 闭包透传 | 无需改 `real-provider-adapter.ts` 的调用形状（accept 签名不变），只改 filter 内部 |
| 规则预览 | 已有 `title`（[:259](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/titles/subscription-policy/preview/route.ts#L259)） | `previewPolicy(policy, resources, { identity })` |

「预览与巡检同一个匹配器」这条核心承诺不变：**身份闸门也放在 `matchPolicy` 内部**，由 options 传入，而不是另写一份。

### 5.3 新增拒绝原因

`PolicyRejectReason` 增加 `"wrong_title"`，并同步三处：

- 预览 badge 文案：`previewReasonCopy` 加 `wrong_title: "不是同一部作品"`
- 诊断优先级（[policy-preview.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/core/policy-preview.ts) 的 `diagnoseEmptyPreview`）：如果**绝大多数排除原因都是 `wrong_title`**，说明是「搜索召回跑偏」而不是「规则太严」，文案要指向搜索词而不是规则。这正好是截图场景的正确解释。
- 审计 `policyReasons` 计数（已有容器，加一个键即可）。

### 5.4 计数语义（第二个问题）

「命中 137 个」要能被读懂，就必须说清它是**什么单位**：

- `matchedCount`（现有）= 通过规则的资源条数，保留（它是「有多少条可转存」）。
- 新增 `matchedPackCount`（含 `全N集`/整季包的条数）与 `matchedSingleCount`，headline 改成：
  `命中 N 条（其中 M 条为整季包，覆盖 K 集单集候选）` —— 用户才看得出「137」是「137 集」还是「137 个版本」。
- 这是纯展示层加法，不改匹配语义，风险低。

### 5.5 UI 层

- 命中清单**只在身份通过后**渲染（这是闸门的直接效果）。
- 0 命中时若诊断是 `wrong_title` 主导，给出可执行建议：`「搜到的多是别的作品」→ 换个更完整的片名 / 加年份 / 用原名重搜`（与 [resource-empty-diagnostic.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/acquisition/components/resource-empty-diagnostic.tsx) 的 over_constrained 同一话术体系）。

### 5.6 实施顺序（每步独立可验）

1. workflow：新增 `TitleIdentity` + `matchIdentity`，嵌入 `matchPolicy`（options 带 identity，缺省则不启用 —— 让既有单测保持绿）。
2. `loadSubscriptionPolicyFilter` 接 `title`；`runner-v2` 三处调用点传 `input.title`。
3. 预览路由传 `title`；`previewPolicy` 透传 options。
4. `wrong_title` 文案 + 诊断优先级 + 计数拆分。
5. 门禁与语料回归。

---

## 6. 门禁与回归测试（同类问题不再回来）

| ID | 门禁 | 类型 | 断言 |
| --- | --- | --- | --- |
| **G9** | 截图语料固定为负样本 | 单测（语料驱动） | 用截图里那 5 条逐字标题 + 《一人之下》《庆余年》《半泽直树》构造语料，断言 `matchPolicy(1080p-only, 资源, {identity: 12 12 12})` 全部 `matched:false, reason:"wrong_title"`；同时断言真资源（`12 12 12.2026.S01E12.1080p`、`12 12 12 S01 1080p`）仍 `matched:true` |
| **G10** | `{tmdb-N}` 冲突即拒 | 单测 | 候选带 `{tmdb-900001}` 而目标 `tmdbId=12345` ⇒ `wrong_title`；带相同 id ⇒ 通过；**不带** ⇒ 不因此被拒 |
| **G11** | 年份冲突即拒、缺年份不拒 | 单测 | `汪汪队立大功.2013` vs 目标 2026 ⇒ 拒；同一候选去掉年份 ⇒ 不因身份被拒 |
| **G12** | 预览不得把「别的作品」计入命中 | 路由测试 | 固定 provider 返回 3 条异构资源，断言 `matched` 只含同名资源；`excluded` 里出现 `wrong_title`；`matchedCount` 与「逐条 matchPolicy」一致 |
| **G13** | 身份闸门在巡检同样生效 | 集成（orchestrator 测试） | agent 可见的候选里不含 `wrong_title`；审计事件 `policyReasons.wrong_title > 0` |
| **G14** | 静态门禁 | `tools/gates` | ① 禁止任何 `matchPolicy(` 调用点不提供 identity 时仍宣称「策略已生效」的路径（用 allowlist 标注纯单测）；② 禁止把字幕/画质词写进身份判定（防止有人用 `mustContain:[片名]` 冒充闸门） |
| **G15** | 计数语义 | 单测 | 季包与单集分别计数，headline 文案含「整季包」字样 |

G9 是核心：**把这次事故的原始标题逐字钉进测试**，任何人再把身份闸门拿掉，测试立刻红。

---

## 7. 风险与取舍

- **误杀**：真实资源标题被 uploader 改写（中文译名不一致、只有英文名）时，闸门可能把真资源拒掉。缓解：`aliases` + `originalTitle` 全部参与（TMDB 数据里本来就有）；阈值调低（词元重叠即可通过，只要不是"完全不沾边"）；拒绝原因单独成类（`wrong_title`），用户**看得见**并能据此改搜索词，而不是被静默排掉。
- **不改变「预览与执行同一匹配器」**：身份闸门在 `matchPolicy` 内，预览与巡检同时获得，不会出现「预览严、巡检松」。
- **历史策略无兼容负担**：按本仓既定策略（未正式发布不做历史兼容），身份闸门直接对所有策略生效，无需迁移。
- **性能**：`parseMediaFileName` 是微秒级纯函数（有既有性能护栏），且每条候选只解析一次（可缓存到 `policyResourceFromTitle` 的结果里）。

---

## 8. 复现记录（可复核）

```
# 环境：仓库内 dist（npm run build:workflow 产物）
const policy = { mustContain:["1080p"], mustNotContain:["CAM/枪版","预告片"],
                 episodeFilter:"", useRegex:false, cooldownDays:0,
                 seasonEpisodeRanges:[{seasonNumber:1,startEpisode:1,endEpisode:null}] };

给你宇宙 (2026) 第1季 全12集 1080P WEB-DL DDP 7.89 GB  → matched:true
法警小队.2026 - S01E12 - … 1080p … {tmdb-290856}        → matched:true
中央情报局.2026 - S01E12 - … 1080p … {tmdb-289560}       → matched:true
汪汪队立大功.2013 - S12E12 - … 1080p … {tmdb-57532}      → matched:true
法律与秩序：特殊受害者.1999 - S27E12 - … 1080p …         → matched:true

# 解析器对同一批标题的输出（证明身份信息其实解析得出来）
给你宇宙        → title="给你宇宙"        year=2026
法警小队        → title="法警小队 2026"   year=2026
汪汪队立大功    → title="汪汪队立大功 2013" year=2013
# 目标作品 12 12 12 的归一化标签
normalizeResourceLabel("12 12 12") = "121212"
```

结论：身份信号（片名 + 年份 + tmdb id）在解析阶段**已经可得**，只是没有进入 `matchPolicy`。

---

## 9. 参考资料

- [Sonarr Settings（Release Profile 与发布名匹配）](https://wiki.servarr.com/sonarr/settings)
- [Sonarr 论坛：发布名里的年份与 scene mapping](https://forums.sonarr.tv/t/sonarr-search-should-properly-handle-year-in-release-title/29924)
- [Radarr Settings](https://wiki.servarr.com/radarr/settings)
- [MoviePilot 优先级规则](https://wiki.movie-pilot.org/advanced)
- [Prowlarr 职责边界](https://wiki.servarr.com/prowlarr)
- 本仓既有调研：[订阅策略配置与执行方案](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/architecture/subscription-policy-execution-research.md)、[2026-11-16 订阅向导可用性调研](file:///E:/WorkProject/Node/_Project/mediary-scout/docs/research/2026-11-16-subscription-policy-wizard-usability-and-template-research.md)

---

## 10. 实施记录（2026-11-17 本轮）

### 10.1 落地的代码

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `packages/workflow/src/execution/title-identity.ts` | `TitleIdentity` / `CandidateIdentity` / `matchIdentity` / `matchIdentityByName` / `titleIdentityFrom` / `leadingLabelOf`。判定顺序：tmdb 硬锚点（相同即放行、不同即拒、缺失不作数）→ 年份硬锚点（差 >1 年拒、缺年份不拒）→ 片名主判定（发布名开头相等 / 双向包含 / 词元重叠 ≥0.6；纯数字片名只认完整包含） |
| 新增 | `packages/workflow/src/domain/resource-label.ts` | 把 `normalizeResourceLabel` 从 `execution/user-requests.ts` 提到 domain 层 —— 身份闸门也要用它，留在 execution 会经 `subscription-policy-store` 形成依赖环（depcruise 已拦下过一次） |
| 改 | `packages/workflow/src/execution/subscription-policy.ts` | `PolicyRejectReason` 加 `wrong_title`；`MatchPolicyOptions` 加 `identity`；`matchPolicy` **第一步**跑身份闸门；新增 `isSeasonPackName`；`previewPolicy` 接受 options 并返回 `matchedPackCount` / `excludedByReason` |
| 改 | `packages/workflow/src/execution/subscription-policy-filter.ts` | `loadSubscriptionPolicyFilter` 接受 `identity`；accept/rejectReason/rank 全部带上；**不传 identity 时行为与之前完全一致** |
| 改 | `packages/workflow/src/execution/runner-v2.ts` | 巡检装配点传 `identityOfTitle(input.title)`（提取成小函数，压回行数棘轮） |
| 改 | `apps/web/app/api/titles/subscription-policy/preview/route.ts` | 预览传 `{ identity: identityOf(title) }`；响应新增 `matchedPackCount` / `excludedByReason` |
| 改 | `apps/web/features/acquisition/core/policy-preview.ts` | `PreviewExcludeReason` 加 `wrong_title`；`previewReasonCopy` 增加文案；headline 说清整季包单位；`diagnoseEmptyPreview` 增加 `wrong_title` 主导分支（>50% 排除原因是 wrong_title 时指向搜索召回而非规则） |
| 改 | `apps/web/features/acquisition/components/{subscription-modal-view,subscription-modal-fields,subscription-policy-panel}.tsx` | 文案统一走 `previewReasonCopy`/`previewHeadlineCopy`（此前向导与详情页各写一份 switch，`wrong_title` 上线时只有一边被更新过）；新增 `wrong_title` 诊断提示 |
| 新增 | `tools/gates/check-title-identity-wiring.mjs`（`npm run gate:identity`） | 四条静态契约：previewPolicy/loadSubscriptionPolicyFilter 生产调用必须带 identity；禁止把片名塞进 mustContain；`wrong_title` 不得在别处另造 |

### 10.2 门禁与测试

- 新增 `packages/workflow/tests/execution/title-identity.test.ts`（27 例）：G9 把**截图里 5 条逐字标题**钉成负样本 + 4 条真资源正向样本；G10 tmdb 三态；G11 年份冲突/容差/缺失；G12 预览计数与逐条一致性；G15 整季包计数。
- `subscription-policy-filter.test.ts` 增 2 例（G13：给 identity 时别的作品被拒且原因是 `wrong_title`；不给 identity 时行为不变）。
- `policy-draft.test.ts` 增 6 例（wrong_title 文案、headline 单位、诊断优先级两向）。
- preview 路由测试夹具的作者身份改为与资源同名（`Show`），否则新闸门会让那些用例测的是「别的作品被拒」而不是原意；type3-worker 的 landing provider 改成用 `title.title` 生成资源名，同理。
- 结果：`npx vitest run packages/workflow/tests apps/web/features/acquisition apps/web/app/api/titles` **312 文件 / 3685 用例全绿**；`npm run gate`（含新增 `gate:identity`）exit 0；`lint` / 两个 `tsc --noEmit` 通过。

### 10.3 Dev 实机验收（开发实例 3020，生产 3000 未动）

用内置浏览器对《12 12 12》（就是事故现场那部）复验：

| 项 | 修复前（截图） | 修复后（实测） |
| --- | --- | --- |
| 详情页策略面板预览 | 命中 137（含《给你宇宙》《法警小队》《汪汪队立大功》） | **命中 1 条**，命中的是 `12 12 12 第一季 … 1080p …`；排除 159 条，原因统计 `不是同一部作品: 159` |
| 创建订阅第 3 步 | 命中 137 个 | **命中 1 条**（共 310 候选）；排除项逐条标注「不是同一部作品」 |
| headline 单位 | 「命中 137 个」 | 「命中 1 条，排除 309 条（共 310 个候选）」——条数与整季包口径分开表述 |
| 排除原因文案 | 「缺少必须包含词」等混杂 | 「不是同一部作品」独立成类，向导与详情页同一份文案 |

附带发现：该片的搜索召回里混入大量无关内容（`精品推荐 …` 成人营销标题、`一人之下`、`名侦探柯南`），这些正是身份闸门要挡的对象。这也说明**召回层面的噪声**与身份判定是两层问题——闸门负责「不把噪声算成命中」，召回优化（缺片名时的搜索词策略）是另一件事，不在本轮范围。

### 10.4 未覆盖与后续

- 真实转存链路（agent 实际获取）未在本轮验收：本轮只改「过滤与预览的判定」，转存前的 `policyFileValidator` 仍只用硬条件（文件已落盘，不再需要身份闸门）。
- 召回噪声（PR 组标题、同名不同剧）需要在搜索词策略层面另做，不属于身份闸门职责。
