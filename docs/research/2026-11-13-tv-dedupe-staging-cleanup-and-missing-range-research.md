# 影视整理去重、staging 清理与缺集范围过滤 · 调研与实施

> 调研日期：2026-11-13
> 现象：`Season 01` 内同一集存在 `S01E01.mp4` / `S01E01(1).mp4` / `S01E01(2).mp4` 三份并存；
> 剧集根目录残留 2 个 `staging-*`；「全部缺集总览」显示 199 集（实际订阅范围是 E190 起）。
> 代码基线：`5bdd97ee`

---

## 1. 结论

| 问题 | 根因 | 修复 |
| :--- | :--- | :--- |
| 季目录内多版本并存 | 去重只发生在 **staging 目录内部**（`organizeStagingDirectory`），已落地的 `Season NN` 从不复查 | 新增 `dedupeSeasonDirectories()`：逐季按 `SxxExx` 重新排序，只留主版本，其余归档 |
| staging 残留 | ① 整理失败/删目录失败后无人回收；② 目录内是**无扩展名视频**，`isVideoFile` 过滤后整理器"看不见" | 新增 `cleanupStagingDirectories()`（整理前 + 收尾各扫一次）；无扩展名文件列为已知缺口 |
| 缺集总览 199 集 | `extractMissingEpisodes()` 全量输出，从不读订阅的季集范围 | 新增 `filterMissingByEpisodeRanges()`，按 `startEpisode/endEpisode` 收窄，并显示过滤依据 |

---

## 2. 现状与代码路径

### 2.1 季目录不复查

`packages/workflow/src/execution/media-organizer.ts`

- `organizeStagingDirectory()` 只 `listTree(stagingDirectoryId)`，落败版本通过 `archiveRedundantTvPackages()` 归档——**作用域仅限 staging**；
- `handleTvOrganize()` 先跑 staging 循环，再 `reconcileTvSeasonDirectories()`（只对齐剧集状态，不动文件）。

于是：多次转存 / 多次整理在 `Season 01` 里留下的 `(1)(2)` 副本，**没有任何代码路径会再处理它们**。

### 2.2 staging 残留

`findTvStagingDirectories()` 能发现所有 `staging-*`，`organizeStagingDirectory()` 在整理成功后会 `removeDirectory`。残留来自两种情况：

1. 删除失败（115 对非空目录/并发操作报错）——没有重试；
2. **目录内文件没有扩展名**：`collectCandidatesFromTree()` 用 `isVideoFile()` 过滤，`[第175集]...ColorTV` 这类转存丢失后缀的文件直接被跳过，于是目录"看起来没有可整理内容"，既不会被搬走也不会被删。

### 2.3 缺集总览无范围概念

`apps/web/features/acquisition/contracts/missing-episodes-model.ts:100` `extractMissingEpisodes()` 遍历所有 `tracked` 季的全部 `episodes`，只按"已播未入库"筛选。订阅策略里的 `seasonEpisodeRanges`（`{seasonNumber,startEpisode,endEpisode}`）从未参与。

结果：起始集设成 190，看板仍列 E001–E199 → "缺 199 集"的噪声数字。

---

## 3. 实测效果（开发实例 3020，真实网盘）

| 指标 | 整理前 | 整理后 |
| :--- | :--- | :--- |
| `Season 01` 文件数 | **363** | **192**（每集一个） |
| 归档重复版本 | — | **194** 个（另有 9 个来自 staging 包） |
| `staging-*` 目录 | 2 | 0（第二次运行收尾清理；其中含无扩展名视频的目录在**首版清理逻辑**下被误删，见 §7.1） |
| 缺集总览 | 缺 **199** 集（E001 起） | 缺 **10** 集（E190 起），并显示"已按订阅范围过滤：第 1 季 E190–不限" |

整理结果文案：`已整理就绪，共提取并规范命名 23 集正片，自动归档 203 个多余版本，归档重复版本 194 个。`

---

## 4. 方案设计

### 4.1 整理侧（策略 + 幂等）

```
OrganizeTvFlow
  1. staging 循环        —— 已有：抽正片 + 归档落败包 + 删 staging
  2. dedupeSeasonDirectories —— 新增：逐 Season 目录按集重排，保留主版本
  3. cleanupStagingDirectories（第一次）—— 删空壳
  4. reconcileTvSeasonDirectories —— 已有：对齐剧集状态
  5. cleanupStagingDirectories（收尾）—— 再扫一次，覆盖整理期间新产生的空壳
```

**为什么去重要按"集"而不是按"目录"**：`rankTvCandidates()` 已经实现了「同集多版本打分」（分辨率/编码/体积/发布组），直接复用它比新写一套判定更安全，也保证电影/剧集口径一致。

**幂等**：第二次整理时 `redundant` 为空 → 不产生任何移动；测试用例 `没有重复时不产生任何移动` 钉住这一点。

### 4.2 缺集侧（纯函数 + 客户端过滤）

- 新增 `filterMissingByEpisodeRanges(items, ranges)`：**未配置范围的季原样保留**（避免误伤）；
- `describeEpisodeRanges(ranges)`：把范围渲染成 `第 1 季 E190–不限`；
- 看板挂载时读 `/api/titles/subscription-policy?tmdbId=...&mediaType=tv`，拿到 `seasonEpisodeRanges` 后过滤，并在标题旁显示过滤依据（可解释性）。

### 4.3 设计模式

| 模式 | 落点 | 作用 |
| :--- | :--- | :--- |
| **策略 Strategy** | `rankTvCandidates`（已有）作为「主版本选择策略」 | 去重与整理共用同一套打分，不产生第二套规则 |
| **模板方法 Template** | `MediaOrganizer` 的「扫描 → 排序 → 落地 → 归档 → 清理」骨架 | 电影/剧集/季目录三种入口复用同一骨架 |
| **状态机 State** | 整理任务的 `planning → executing → verifying → done` | 当前仍是同步执行；后续加 dryRun/回滚时按此扩展 |
| **规格 Specification** | `filterMissingByEpisodeRanges` 的 range 判定 | 纯函数、可组合，便于后续叠加"只看已播/只看缺失"等条件 |

---

## 5. 业界对照

| 来源 | 做法 | 启示 |
| :--- | :--- | :--- |
| **Sonarr** | 同一集多版本只保留一个，其余进 Recycle Bin；有「Manual Import」处理无法识别的文件 | 与我们一致：主版本 + 归档 + 人工兜底 |
| **Radarr** | 同上，且每次「Rescan」都会重新评估重复 | 关键差异：**它们每次扫描都复查**，我们只在整理时复查 |
| **Plex/Jellyfin** | 多版本可并存（`- 1080p` / `- 2160p`），由播放器聚合 | 说明"保留多版本"是合法需求，因此归档而非删除是对的 |
| **TRaSH Guides** | 明确「同一集只保留最佳版本，其余删除或归档」 | 支撑当前策略 |

---

## 6. 可复用资产

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| `rankTvCandidates` | `execution/version-ranker.ts` | 同集多版本打分（分辨率/编码/体积/发布组/样片识别） |
| `StorageArchiveAdapter` | `storage/storage-archive-adapter.ts` | 幂等创建 `Archive/{TV|Anime}/<Title>/` 并原子移动 |
| `isVideoFile` / `isExtraOrSample` | `version-ranker.ts` | 视频与样片判定（也是"无扩展名"缺口的来源） |
| `seasonEpisodeRanges` | `subscription-policy` API | 缺集过滤的数据源，已持久化，无需迁移 |
| `MissingEpisodesDeck` | `features/acquisition/components` | 已有分页/季筛选，只需前置过滤 |

---

## 7. 事故与缺口

### 7.1 首版清理逻辑误删（已修复，需人工恢复）

首版 `cleanupStagingDirectories` 用 `isVideoFile()` 判断"目录里有没有视频"。
`staging-42218692` 里两个文件**没有扩展名**（`...[第175集]...ColorTV`），被判定为"非视频"，
于是整个目录被删除 —— 而这两个文件是 1GB+ 的真实正片。

**修复**：改为白名单式判定 `isSafeToRemoveStaging()`：

```
可删除 ⇔ 目录为空
        ∨（全部是 nfo/txt/url 等已知垃圾 ∧ 总体积 < 50MB）
```

并补了回归用例「含无扩展名大文件时绝不删除」。

**恢复动作**：115 网盘删除默认进回收站，请在 115 网页端/客户端「回收站」中还原
`staging-42218692-9b32-42aa-84c3-3d48736d5802` 下的两个文件，再点一次「整理与多版本归档」。

**教训**：删除类操作不能以"识别不出 = 不存在"为前提；扩展名不是可信信号。

---

## 7.2 已知缺口（本轮未修）

**无扩展名视频无法被整理**：`isVideoFile()` 依据扩展名判定，`[第175集]...ColorTV` 这类转存丢失后缀的文件会被跳过，导致其所在 staging 目录既不能整理也不能删。

候选方案（按风险排序）：

1. **低风险**：整理结果里显式列出「N 个文件未识别（缺少扩展名）」，并提供一键"补 .mp4 后整理"；
2. **中风险**：对 ≥200MB 且无扩展名的文件，按容器魔数（ftyp/matroska）嗅探真实类型再补后缀——需要下载文件头，成本较高；
3. **不推荐**：无条件补 `.mp4`，容器不符时播放器会直接失败。

---

## 8. 门禁与测试

| 类型 | 用例 |
| :--- | :--- |
| 单测 | `dedupeSeasonDirectories`：同集 3 版本 → 归档 2 个；无重复 → 0 移动 |
| 单测 | `cleanupStagingDirectories`：空壳删除、含视频保留 |
| 单测 | `filterMissingByEpisodeRanges`：无范围不误伤 / 起始集 / 结束集 / 未配置季 / 描述文案 |
| 实机 | `verify-missing-range.mjs`：缺集 199 → 10，且出现过滤提示 |
| 实机 | `verify-organize-dedupe.mjs`：363 → 192，归档 194，staging 减少 |

**注意**：测试夹具的视频体积必须 ≥40MB，否则会被 `isExtraOrSample` 判定为样片而归档（本轮踩过一次）。

---

## 8. 低风险版实施：缺扩展名文件的可观测与一键补全

§7.2 列了三档方案，本轮落地推荐档（**只报告 + 读文件头补后缀**），不动「按文件名猜」这条高危路径。

### 8.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| 疑似正片识别 | `packages/workflow/src/execution/unrecognized-media.ts` | `looksLikeVideoWithoutExtension()`：无视频扩展名 + 非垃圾扩展名 + 体积 ≥ 100MB。**不依赖文件名关键词**——发布组命名千奇百怪，关键词只会带来误判 |
| 容器嗅探 | 同上 `sniffVideoContainer()` | 读前 32 字节按 magic bytes 判定：`ftyp`→mp4、EBML→mkv、`RIFF..AVI `→avi、`FLV`→flv、0x47 同步→ts；判不出返回 `unknown` |
| 目录扫描 | 同上 `scanUnrecognizedMedia()` | 剧集根目录 + 各 `Season NN` + 各 `staging-*`；单目录失败不影响整体 |
| 整理结果告知 | `organize-handlers.ts` + `organize-cleanup.ts` | 响应新增 `unrecognizedCount`，文案追加「另有 N 个文件缺少扩展名未参与整理」 |
| 一键补后缀 API | `api/titles/organize/unrecognized/route.ts` | `GET` 列候选；`POST` 解析直链 → 读文件头 → 改名；含归属校验（403）与参数校验（400） |
| 改名生效回查 | 同上 `confirmRenames()` | 改名后重新列举目录确认新名字存在，不在则按失败上报——**不采信上游「返回成功」** |
| 前端提示条 | `storage/organize-unrecognized-prompt.tsx` + `use-folder-organize.ts` | 整理成功且 `unrecognizedCount>0` 时出现；点「一键补全扩展名」→ 调 API → 汇报「已为 N 个补全，M 个跳过（原因）」 |
| 响应构造抽离 | `api/titles/organize/organize-tv-response.ts` | 处理器已到 600 行预算，把展示层分支（已对齐/无变化/需人工）移出编排逻辑 |

单测：`unrecognized-media.test.ts`（17 例：识别/嗅探/改名/扫描容错）、`use-folder-organize.test.ts` 增补 `describeFixResult`（4 例）、`unrecognized/route-contract.test.ts`（AST 结构门禁 4 例）。

### 8.2 实机验证（dev 3020）

| 检查项 | 实测 | 结论 |
| :--- | :--- | :--- |
| 真实 mkv 文件头 | `1a 45 df a3 … matroska` | 嗅探为 `mkv` ✓ |
| 真实 mp4 文件头 | `00 00 00 20 66 74 79 70 69 73 6f 6d` | 嗅探为 `mp4` ✓ |
| `GET` 正常 | `200 {count:0}`（该剧集当前无缺扩展名文件） | ✓ |
| `GET` 缺参数 | `400 {code:"INVALID_QUERY"}` | ✓ |
| `GET` 越权盘 | `403 {code:"STORAGE_FORBIDDEN"}` | ✓ |
| 提示条渲染 | 拦截 organize 返回 `unrecognizedCount:3` → 蓝色提示条「有 3 个文件缺少扩展名…」+ 两个按钮，pageerror 0 | ✓ |
| 一键补全接线 | 点击后 POST `{storageId, directoryId}` → 提示条消失 → 结果文案「已为 2 个文件补全扩展名，1 个跳过（无法识别容器格式（未改动））」 | ✓ |

### 8.3 平台约束（重要，实测得出）

**115 的重命名会保留原扩展名，无法改扩展名。** 实测同一文件连续改名：

| 请求的新名字 | 实际结果 |
| :--- | :--- |
| `probe_a.ColorTV` | `probe_a.mkv` |
| `probe_b.mp4` | `probe_b.mkv` |
| `probe_c`（无扩展名） | `probe_c.mkv` |

即 `files/batch_rename` 只接受「主体名」，扩展名由平台固定。由此得到两个推论：

1. **无法通过改名制造「缺扩展名」文件**，所以本轮端到端只能在真实盘上验证到「扫描 / 校验 / UI 接线」，
   补后缀的成功路径由单测 + 真实文件头嗅探覆盖；
2. 缺扩展名的文件只能来自**转存时的名字截断**，且补后缀在 cookie 通道上**可能被平台拒绝**。
   为此路由增加了 `confirmRenames()` 回查：平台若静默不改，结果如实报「改名未生效（上游未接受）」，
   绝不谎报成功。

另外，115 执行器的 `renameFile` 会**优先走 Open API**（`file/update` 的 `file_name` 是全名，未观察到扩展名固定行为），
Open API 不可用时才降级到 cookie 通道。因此 OAuth 正常时补后缀应当可用；生产当前 OAuth 处于 `frozen`，
该功能会先在「无法解析直链」处失败并如实上报。

### 8.4 仍未做

| 项 | 原因 |
| :--- | :--- |
| 转存时保留扩展名（根治） | 需在 `transfer` 落盘阶段对目标名做「补全扩展名」策略，涉及秒传与分享目录结构，属独立改造 |
| 无扩展名文件的播放兜底 | STRM 播放路由已支持 `?name=` 参数，理论上可传 `name=xxx.mkv` 让 Plex 识别；未做端到端验证 |
| 缺扩展名文件的整理 | 平台不允许改扩展名时无解；只能在转存阶段预防 |
