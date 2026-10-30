# 规格：媒体身份来源前缀（方案 §2.2 / 批次 1 遗留项）

## Goal

把媒体身份从「散落各处的模板字面量与手写正则」收敛为单一类型化模块，使接入第二个
元数据源时只需加一个联合成员，且解析失败显式可辨——同时**不改 wire format、
不做数据库迁移**。

## 对方案原文的一处更正

方案 §2.2 写「本项目当前是裸 `tmdbId`（`tmdb_tv_283428` 形式）」——这两句自相矛盾。
实测：`tmdb-provider.ts` 等处产出的就是 `tmdb_tv_283428` / `tmdb_movie_238`，
**来源前缀已经在字符串里了**。所以缺口不是「缺前缀」，而是：

- 没有 `MediaSource` 类型，来源只是字符串里的一段，任何代码都能拼出另一种格式而
  编译器无感；
- 5 种 id 格式由约 10 处模板字面量构造、3 处手写正则解析，分散在不同文件，
  且正则之间已有细微差异（`demo-candidates.ts` 用 `/^tmdb_tv_(\d+)_s\d+$/`，
  `workflow-runtime.ts` 用 `/^tmdb_tv_(\d+)_s(\d+)$/`——同一格式两份写法）；
- 解析失败一律返回裸 `null`，「id 写错了」和「这片不在库里」在上层无法区分。

也因此：**不需要 format 迁移**。方案说的「现在改是一行类型的代价」在格式层面本就
已付过，剩下要付的是类型层。

## Scope

`packages/workflow/src/media-identity.ts` 新建：

- `MediaSource` 联合（今天只有 `"tmdb"`）
- 四个 builder：title id / movie candidate id / tv candidate id / trackedSeason id
- 四个 parser：返回带 `reason` 的判别联合

调用点迁移（构造/解析 id 的点，约 15 处，分布在 8 个文件）：

| 文件 | 处数 |
|---|---|
| `packages/workflow/src/tmdb-provider.ts` | 3 模板 |
| `apps/web/lib/workflow-runtime.ts` | 2 正则 |
| `apps/web/lib/title-hub.ts` | 3 模板 |
| `apps/web/lib/user-message-server.ts` | 1 模板 |
| `apps/web/lib/demo-workflow.ts` | 3 模板 |
| `apps/web/lib/agent-api/acquire.ts` | 1 模板 |
| `apps/web/lib/demo-candidates.ts` | 1 正则 |
| `apps/web/app/show/[tmdbId]/page.tsx` | 1 模板 |

新增漂移守护测试：断言 `packages/{workflow,shared}/src` 与 `apps/web/lib`、
`apps/web/app` 里不存在模块外的格式字面量与解析正则。

## 不改（Non-goals）

1. **不改 wire format**。改了就要动 `media_titles`/`tracked_seasons`/`user_messages`/
   `resource_snapshots` 四张表——这些表按 title_key 索引，等于换主键。
2. 不新增 `media_source` 列或新表：来源已可从 id 前缀恢复，加列是冗余。
3. 不接入第二个元数据源（豆瓣/IMDb/TVDB）。本任务只为它铺路。
4. 不碰 Prowlarr/Jackett 的 id 体系。
5. 不改前端展示、不改 API 响应结构。
6. 不追求覆盖全部 60 个非测试文件；只收敛构造/解析 id 的点，透传的不动。

## 验收后修正（2026-10-28，对抗性自审发现）

规格第 2 条写「解析失败返回带 reason 的判别联合，**绝不返回裸 null**」。第一版实现时
我在 `workflow-runtime.ts` 留了两个本地包装函数，把 reason 打进 `console.warn` 后仍返回
`number | null`——理由是「不动四个调用点的控制流」。自审判定这是**规格违规，不是设计**：
调用方依然拿到裸 null，只是日志里多了原因。

已拆掉包装，四个调用点直接接判别联合，并因此多做一件事：把「id 畸形」与「id 合法但不是
这个种类」分成两条用户文案。合成一句「只有电影可以预定」会让人去查不存在的功能限制，
从而放过真正的数据污染点。判据抽成 `unsupportedCandidateId()` 一个函数——内联进两个
入口会把 `queueCandidateSeries` 的 ESLint 复杂度推过 15（实测红过一次）。

新分支的测试是变异逼出来的：第一次写完测试，删掉 malformed 分支，129 条照样全绿——
**新行为没有测试覆盖**。补了 3 条后再变异，2 条红。

## 验收标准

1. 本仓不再有模块外的 `tmdb_tv_`/`tmdb_movie_` 模板字面量与解析正则。
   **迁移完成的判据是 grep 归零，不是「新模块存在」。**
2. 解析失败返回带 `reason` 的判别联合，绝不返回裸 `null`。`reason` 至少区分
   `unknown_source` / `malformed` / `not_a_title_id`。
3. 往返恒等：`parse(build(x))` 还原 x，`build(parse(id))` 还原 id。
4. 严格性：`tmdb_tv_283428_s1` 喂给 `parseTitleId` 必须失败（静默误匹配的那一类）；
   `tmdb_tv_abc`、`tmdb_tv_`、空串、前后空白都必须失败。
5. 漂移守护测试有牙：新增第五种格式或绕过模块，测试红；且用变异证明「只扫一个目录」
   的漏扫版本会红。
6. `MediaSource` 是联合类型且今天只有 `"tmdb"`；加第二个成员时所有 exhaustive
   分支编译报错（用 `satisfies`/`never` 收口，不用宽化的数组类型）。
7. gate 0、vitest 全绿、build:workflow 0、wf-tsc 与 web-tsc 均 0。
   **不引入数据库迁移。**
8. 每个 builder/parser 都有红→绿证据；迁移用变异验证。

## Failure modes

| # | 模式 | 正确行为 |
|---|---|---|
| 1 | **静默误匹配**（核心）：`parseTitleId("tmdb_tv_283428_s1")` 宽容地吃掉前缀返回 `{tmdbId:283428}`，把 trackedSeason id 当 title id——两个格式只差一个后缀，最容易混 | 解析锚定完整字符串（`^...$`），更长/更短的变体显式报错 |
| 2 | 未知来源：未来库里出现 `douban_1295644`，旧二进制读到时返回 null，上层当成「查无此片」 | 报 `unknown_source`，调用方记日志 |
| 3 | 数字边界：`Number("00")`、`Number("1e3")`、超长数字串被静默接受成另一个 id | 显式数字形态校验 |
| 4 | 假绿·测试断言旧字符串：实现改了格式，测试仍断言字面量故仍绿 | 测试用 builder 产出期望值；只在**一处**格式契约测试里断言字面量 |
| 5 | 假绿·漂移守护漏扫：只扫 `packages/*/src` 漏 `apps/web/lib`，迁移没完成却显示绿 | 守护测试显式覆盖多目录，并有变异证明漏扫会红 |
| 6 | 假绿·迁移不完整：只加新模块不换调用点，grep 仍有字面量但测试全绿 | 以 grep 归零为准绳 |
| 7 | 回归：wire format 一变等于换主键，四张表全部错位 | 明确不做 format 迁移（前提） |

## 优先级

正确性 > 门禁全绿 > 覆盖面。冲突时：宁可少迁移几个调用点并留下 grep 可见的 TODO，
也不能为让测试绿而放宽解析严格性。覆盖面明确排最后——60 个文件里真正构造/解析 id 的
只有约 15 处，其余只是透传。
