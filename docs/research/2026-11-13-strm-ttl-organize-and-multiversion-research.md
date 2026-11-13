# STRM 播放地址有效期 / 订阅入库整理 / 目录级整理与多版本归档 · 调研与方案

> 调研日期：2026-11-13
> 关联文档：`2026-11-13-player-telemetry-and-startup-latency-research.md`、`2026-11-13-subtitle-matching-and-remaining-optimizations-research.md`
> 实测环境：开发实例 `mediary-dev`（端口 3020），代码基线 `306e69ba`
> 主机地址统一以 `<DEV_HOST>` 占位；真实凭据仅存于 `env/.envdev`。

---

## 1. 结论摘要

| 问题 | 结论 |
| :--- | :--- |
| ① STRM 地址是否只有 10 分钟有效 | **不是**。`.strm` 内的签名 token 默认 **365 天**（`DEFAULT_STRM_TTL_SECONDS`）。真正短命的是**上游网盘 CDN 的签名直链**，以及我们**假设**的缓存 TTL（115 = 2h、夸克 = 1h）。目前系统**不解析上游真实过期时间，也不在 403 时自动续期**——这才是长片播放会断的根因 |
| ② 订阅/入库/整理是否有问题 | **有**。扫描器**只索引、从不重命名**；`MediaOrganizer` 只重命名 **TV 单集文件**，**电影文件不重命名**；legacy 目录（`Title (Year)`，无 `{tmdb-N}`）**永不升级**；订阅入库路径**不保证触发整理**；动漫的多集包/绝对集数会落进 `unresolved` 被跳过 |
| ③ 网盘目录内能否按标准整理并归档 | **部分可以**。网盘管理页已有「整理当前目录」入口，但**仅在目录名或面包屑含 `{tmdb-N}` 时出现**；多版本目前是「选主版本 + 其余丢进 `Archive/`」，**不支持并排多版本标准命名**（`Movie - 1080p.mkv` / `- 2160p.mkv`） |

三者共性是：**能力大多已存在，缺的是"何时触发、对谁生效、失败后怎么自愈"**。所以优化重点不是重写，而是补状态机（何时重试/何时整理）、补策略（命名与归档规则可配置）、补幂等（重命名可回滚）。

---

## 2. 问题一：播放地址有效期与长片播放

### 2.1 代码事实（不是猜测）

| 环节 | 有效期 | 来源 |
| :--- | :--- | :--- |
| `.strm` 文件内 URL 的 `token`/`exp` | **365 天**（可配 `ttlSeconds`） | `strm-writer.ts:3` `DEFAULT_STRM_TTL_SECONDS` |
| 直链缓存 `strm_link_cache.expires_at` | 115 = **7200s**、夸克/UC = **3600s** | `stream-resolver.ts:139/179/213`、`route.ts:298` |
| 上游 CDN 签名直链 | **由网盘决定，系统未解析** | `parseProApiDecryptedEntry` 只取 url/file_name/file_size |
| 播放接口本身的 URL | 无 `exp` 时**永不过期**（`STRM_AUTH_STRICT=true` 才强制签名） | `route.ts:204` |

所以「10 分钟」既不是我们配置的，也不是 `.strm` 的 TTL。它最可能是**上游 115 直链的实际有效期**——我们在 `expirationSeconds: 7200` 里写死 2 小时，如果真实只有 10–30 分钟，缓存就会"记住一个已死的 URL"。

### 2.2 长片播放的三个断点

```
播放开始 ──302/代理──> 上游 CDN（签名 URL，真实 TTL 未知）
   │
   ├─ 断点 1：播放中途 seek / 网络重连 → 浏览器重新请求
   │            若走 redirect：直接打到已过期的 CDN URL → 403
   │            若走 proxy：命中缓存里的旧 URL → 上游 403 → 原样透传 403
   │
   ├─ 断点 2：媒体服务器（Emby/Jellyfin）定时重扫 .strm → 重新请求 → 同上
   │
   └─ 断点 3：缓存 TTL（2h）到期 → 重新解析 → 恢复；但在此之前一直 403
```

**关键欠缺**：`handleStreamProxy` 对上游 401/403/410 **没有任何处理**——不失效缓存、不重解析、不重试，直接把 403 返回给播放器。于是"链接过期"在用户侧表现为"播放到一半突然卡死，等两小时或重启才恢复"。

### 2.3 优化方案

**A. 缓存自愈（最高优先级，改动最小）**

在 `resolveAndCacheStream` 外层加一个「失败即失效并重试一次」的装饰器：

```
serveStream(url) → 上游 401/403/410
  → repo.deleteStrmLinkCache(cacheKey)
  → resolver.resolveStream(同 key)  (SingleFlight 去重)
  → 重试一次（仅一次，避免风暴）
  → 仍失败则返回 502 并带可读原因
```

- 只对幂等的 GET/HEAD 生效；只重试一次；重试仍失败时**不写回缓存**。
- 复用既有 `SingleFlight`，天然合并并发 Range 请求。

**B. 解析上游真实过期时间**

115 的 downurl 响应若含 `expire`/`exp` 字段，应据此设置缓存 TTL，而不是写死 7200。拿不到时保留 7200 作为上限，并加一个"保守下限"（例如 600s），避免把 10 分钟有效期的链接缓存 2 小时。

**C. 客户端断点续播**

播放器已有 `art.on("error")` → `switchUrl(fallback)`。建议扩展为：

```
video:error（且已播放过 currentTime > 0）
  → POST /api/strm/refresh { storageId, fileId }  (失效缓存)
  → art.switchUrl(同一 URL + cache-busting 查询参数)
  → 恢复 currentTime
```

注意：`switchUrl` 同一 URL 会被浏览器缓存命中，需带一次性参数（如 `&_r=<ts>`）。

**D. STRM 令牌 TTL 策略化**

当前 1 年 token 的便利性与安全性需要权衡：`.strm` 一旦泄露，等于永久可播。建议按部署形态给默认值（个人 NAS 30 天、公网 7 天），并支持 secret 轮换（轮换后旧 token 全失效，需重新生成 .strm）。

**E. 模式建议**

- 长片（>2h）优先 **proxy**：服务端可自愈，客户端无感；
- 局域网/直连优先 **redirect**：省服务器带宽，但依赖上游 TTL；
- 两者切换已由 `resolveDeliveryMode` 责任链承载，只需把"片长"纳入决策因子。

### 2.4 风险

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 重试风暴 | 播放器并发 Range 全部 403 时同时重解析 | SingleFlight + 只重试一次 |
| 网盘限流 | 重解析会消耗 115 漏桶（1.2s/次） | 重试前检查 pacer 余量；失败降级为提示 |
| 缓存击穿 | 删除缓存瞬间并发涌入 | 先 SingleFlight 再删缓存，或删除后立即回填 |

---

## 3. 问题二：订阅 / 入库 / 整理链路

### 3.1 现状链路（实测）

```
订阅 → 获取(acquisition-v2) → 转存 staging → MediaOrganizer 整理 → 入库(scan)
                                              ↑ 只有这条路径会改名
网盘已有文件 → 扫描入库(library-scanner) → 只建索引，不重命名
```

- `library-scanner.ts` **没有任何 rename/move 调用**（已 grep 确认）——所以"盘里原来叫什么，库里就叫什么"。
- `MediaOrganizer.organizeMovieDirectory()` **只搬文件、不重命名**（`media-organizer.ts:159-214`，无 `renameFile`）。
- `MediaOrganizer.placePrimaryTvEpisodes()` 会重命名单集为 `Title - S01E02 [tags].ext`（`media-organizer.ts:263`）——**只有 TV/动漫受益**。
- 电影目录名由 `mediaLibraryFolderName()` 生成 `Title (Year) {tmdb-N}`，但 `ensureMediaLibraryDirectory()` 对**已存在的 legacy 目录只复用、不改名**（`media-library-folder.ts` 注释明确"do not auto-rename this round"）。

### 3.2 五个具体缺口

| # | 缺口 | 表现 |
| :-- | :--- | :--- |
| G1 | 电影文件不重命名 | 电影根目录里仍是 `The.Hotel.New.Hampshire.1984.1080p.BluRay.x265-RARBG.mp4`，而非 `新汉普夏饭店 (1984).mp4` |
| G2 | legacy 目录永不升级 | `凡人修仙传 (2020)` 不会变成 `凡人修仙传 (2020) {tmdb-106449}`，导致网盘侧整理按钮不出现 |
| G3 | 订阅入库不保证整理 | 订阅链路只在 acquisition 内整理；网盘已有内容与"非 agent 路径"的转存不会触发 |
| G4 | 动漫多集/绝对集数 | `[01-12]` 合集包、`- 13`（第二季绝对集数）会解析成 S01E13 或落 `unresolved` |
| G5 | 无批量回填 | 没有"对已入库的全部条目做一次标准化"的入口 |

### 3.3 优化方案

**策略化命名（Strategy）**

把命名规则抽成可配置策略，而不是散落在 `media-organizer`：

```
NamingPolicy {
  movieFile: (ctx) => string        // 默认 `Title (Year).ext`，可带 `{tmdb-N}`
  episodeFile: (ctx) => string      // 默认 `Title - SxxExx [tags].ext`
  seasonDir: (n) => string          // `Season 01`
  titleDir: (ctx) => string         // `Title (Year) {tmdb-N}`
  sanitize: (name) => string        // 非法字符、长度、保留字
}
```

**状态机化整理任务（State）**

```
idle → planning → dryRun → awaitingConfirm → executing → verifying → done
                                     ↘ failed(可回滚) ↘ partial(需人工)
```

价值：重命名是**破坏性**操作，必须先 `dryRun` 出计划（旧名 → 新名、冲突、跳过原因），确认后执行，执行后 `verifying` 校验（文件数、可播放性），失败可回滚。

**幂等与可回滚**

- 每次整理写一条 `organize_jobs` 记录（目录、计划、结果、时间），支持"撤销上一次"（按记录反向 rename）。
- 重命名前检查目标名是否已存在：存在则跳过并记 `conflict`，绝不覆盖。

**动漫专门处理**

- 合集包（`[01-12]`）：按 TMDB 季集映射拆分，或至少标记 `needs_manual_split`；
- 绝对集数：用 TMDB `episode_groups`（绝对顺序）映射到 `SxxExx`；
- 已有 `episodeCodeFromFileName` 的 `fallbackSeason` 参数可作为映射入口。

**批量回填入口**

在媒体库/网盘页提供"标准化全部"：按库 → 逐标题 dryRun → 汇总确认 → 执行。必须限速（复用品牌 pacer）并支持中断续跑。

---

## 4. 问题三：目录级整理与多版本归档

### 4.1 现状

- 网盘管理页 `handleOrganizeCurrentFolder()` 会 POST `/api/titles/organize`，但按钮**仅当** `resolveTmdbIdFromListing()` 能从当前目录名或面包屑解析出 `{tmdb-N}` 时出现。
- 归档结构：`/Mediary Scout/Archive/{Movies|TV|Anime}/<Title>/`（`storage-archive-adapter.ts:19-27`）。
- 多版本：`rankMovieCandidates()` 选一个主版本，其余作为 `redundant` 归档——**可见目录里只留一份**。

### 4.2 缺口

| # | 缺口 | 影响 |
| :-- | :--- | :--- |
| D1 | 无 `{tmdb-N}` 的目录不能整理 | 存量目录（绝大多数）完全无法从网盘侧整理 |
| D2 | 多版本只归档、不并排 | 用户想同时保留 1080p/2160p 时，另一份被移进 Archive |
| D3 | 无 edition/version 命名 | 导演剪辑版、加长版无法被播放器识别为同一影片的不同版本 |
| D4 | 电影文件名不规范 | 与 G1 同源 |

### 4.3 业界标准（可直接采纳）

| 生态 | 目录 | 多版本文件命名 |
| :--- | :--- | :--- |
| **Jellyfin** | `Movies/Title (Year) [tmdbid-123]/` | `Title (Year) - 1080p.mkv`、`Title (Year) - 2160p.mkv`（同名不同后缀自动识别为多版本） |
| **Plex** | `Movies/Title (Year)/` | `Title (Year) {edition-Director's Cut}.mkv` |
| **Radarr** | `{Movie Title} ({Release Year}) {Quality Full}` | 支持 `{edition-{Edition Tags}}` |
| **Sonarr** | `{Series Title} ({Year})/Season {season:00}/{Series} - S{season:00}E{episode:00} - {Title}` | — |

**建议**：目录统一 `Title (Year) {tmdb-N}`（与现有实现一致，且 Jellyfin 也认 `[tmdbid-N]` 变体）；多版本文件统一 `Title (Year) - <Quality>.ext`，并把 `rankMovieCandidates` 的 `redundant` 从"归档"改为**可配置策略**：

```
MultiVersionPolicy = "archive" | "side-by-side" | "ask"
```

- `archive`（现状）：只留主版本；
- `side-by-side`：全部保留并按画质后缀命名（Jellyfin 会聚合成一个影片的多个版本）；
- `ask`：dryRun 里让用户勾选。

### 4.4 无 tmdb 目录怎么办

`resolveTmdbIdFromListing` 目前只认 `{tmdb-N}`。建议增加二级识别：

1. 目录名含 `{tmdb-N}` → 直接用；
2. 目录名形如 `Title (Year)` → 用 TMDB 搜索 + 年份精确匹配，命中后**先改名再加 tmdb 后缀**（这是 G2 的修复入口）；
3. 都没有 → 允许手动输入 tmdbId 后整理。

第 2 步需要 TMDB 搜索（已有 `tmdb-provider.ts`），但要防误配：必须 `title + year` 双匹配，且只接受唯一结果。

---

## 5. 设计模式落点

| 模式 | 落点 | 解决什么 |
| :--- | :--- | :--- |
| **策略 Strategy** | `NamingPolicy`、`MultiVersionPolicy`、`ExpiryPolicy`（缓存 TTL 来源） | 命名/归档/有效期规则可配、可测，不再散落魔法值 |
| **状态机 State** | `OrganizeJob`（planning→dryRun→executing→verifying→done/failed）、`StreamLink`（fresh→stale→refreshing→fresh/failed） | 破坏性操作必须先计划后执行；链接过期要有明确迁移而不是"卡住" |
| **适配器 Adapter** | `StorageNamingAdapter`（各网盘 rename/move 差异）、`ProviderExpiryAdapter`（115/夸克/UC 的过期字段解析） | 网盘能力差异收敛，新增驱动不用改整理逻辑 |
| **装饰器 Decorator** | `SelfHealingLinkResolver`（失败失效+重试）包在现有 `StorageStreamResolver` 外 | 不改解析器实现，横向加自愈 |
| **命令 Command** | 整理计划中的每个 rename/move 是一条可撤销命令 | 支持 dryRun 预览与一键回滚 |

**不建议**：为整理引入工作流引擎；现有 `organize_jobs` 表 + 状态字段足够。

---

## 6. 库与业界参考

| 需求 | 可用方案 | 结论 |
| :--- | :--- | :--- |
| 文件名清洗 | `sanitize-filename` / `filenamify` | 已有 `cleanMediaTitle`，补非法字符与长度截断即可，**不必引入** |
| 季集解析 | `anitomy`（动漫文件名解析，JS 移植 `anitomy-js`） | **值得评估**：能解析 `[SubGroup] Title - 12v2 [1080p]`、多集、版本号，比现有正则更全 |
| 多集拆分 | `mkvmerge` / `ffmpeg` | 需外部二进制，**暂不引入**，先做"标记待人工" |
| 绝对集数映射 | TMDB `episode_groups` | 已有 TMDB 客户端，**直接复用** |
| 重命名事务 | 无通用库 | 自建 `organize_jobs` + 反向命令 |

业界对照（Radarr/Sonarr/Jellyfin/Plex）共性：**命名模板可配置 + 先预览后执行 + 冲突不覆盖 + 有回收站**。我们缺的是"预览/回滚"与"可配置模板"，不是解析能力本身。

---

## 7. 可复用资产

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| `MediaOrganizer` | `packages/workflow/src/execution/media-organizer.ts` | 已实现电影/剧集整理主流程，扩展而非重写 |
| `rankMovieCandidates` / `rankTvCandidates` | `execution/version-ranker.ts` | 多版本打分，已有画质/发布组/体积权重 |
| `StorageArchiveAdapter` | `storage/storage-archive-adapter.ts` | 归档目录幂等创建 |
| `canonicalEpisodeFileName` / `episodeCodeFromFileName` | `domain/episode-code.ts` | 单集命名与解析，动漫场景可增强 |
| `mediaLibraryFolderName` | `domain/media-library-folder.ts` | 目录命名规范 |
| `StorageStreamResolver` + `SingleFlight` | `storage/stream-resolver.ts` | 链接自愈装饰器的挂载点 |
| `strm_link_cache` 表 | `sqlite-schema.ts` | 已支持按 key 删除，自愈可直接复用 |
| `tmdb-provider.ts` | `providers/` | 目录名 → tmdbId 的二级识别 |

---

## 8. 实施计划与验收

| 期 | 内容 | 成本 | 验收 |
| :--- | :--- | :--- | :--- |
| **P0** | 链接自愈：上游 401/403/410 → 失效缓存 + 重试一次 | 0.5 天 | 构造过期链接，播放能自恢复；无重试风暴 |
| **P1** | 电影文件重命名（`Title (Year).ext`）+ 冲突跳过 | 1 天 | 整理后电影文件名合规；冲突文件不被覆盖 |
| **P2** | legacy 目录升级（`Title (Year)` → `+ {tmdb-N}`），TMDB 双匹配 | 1–2 天 | 无 tmdb 目录也能从网盘侧整理 |
| **P3** | 多版本策略（archive / side-by-side） | 1–2 天 | 选择 side-by-side 后两个版本并存且被播放器识别 |
| **P4** | 整理 dryRun + 回滚 + 批量回填 | 2–3 天 | 预览 → 执行 → 撤销 全链路可用 |

### 验收断言（建议）

```text
1. 过期自愈：把缓存 URL 改成 403 的假地址 → 播放请求应返回 206 且缓存被替换
2. 电影命名：整理后文件名匹配 /^.+ \(\d{4}\)\.(mkv|mp4)$/
3. 目录升级：`X (2020)` 目录整理后变为 `X (2020) {tmdb-N}`
4. 多版本：side-by-side 下同目录存在 `... - 1080p.mkv` 与 `... - 2160p.mkv`
5. 幂等：连续整理两次，第二次返回 already_clean 且无任何 rename
```

---

## 9. 风险与边界

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 重命名不可逆 | 网盘 rename 无事务 | 先 dryRun、写 job 记录、冲突不覆盖、支持反向命令 |
| 网盘限流 | 批量整理会触发 115 漏桶 | 复用 `withBrandPacing`，支持中断续跑 |
| TMDB 误配 | 同名不同片 | 标题 + 年份双匹配，只接受唯一结果 |
| 播放中断 | 自愈重试期间短暂失败 | 客户端保留 currentTime，恢复后 seek 回去 |
| 权限 | 媒体服务器可能缓存旧 .strm | 提供"刷新 .strm"入口 |

---

## 10. 实施记录与验收（P0 + P1）

### 10.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| P0 直链自愈 | `api/strm/play/[taskId]/[fileId]/route.ts` + `strm/link-expiry.ts` | 命中缓存后若上游返回 401/403/410：把该缓存条目覆盖为「已过期墓碑」（`expiresAt=0`）→ 重新解析 → 重试一次。重试仍失败返回 502 并带原因 |
| P0 判定纯函数 | `packages/workflow/src/strm/link-expiry.ts` | `isExpiredLinkStatus` / `shouldRetryWithFreshLink`，只对「来自缓存」且「过期语义」的状态重试，避免重试风暴 |
| P1 电影文件重命名 | `packages/workflow/src/domain/movie-file-name.ts` + `MediaOrganizer.renamePrimaryMovie` | 整理时把主版本改为 `Title (Year).ext`（保留方括号发布标签）；目标名已存在则跳过并记 `renameConflict`，绝不覆盖 |
| P1 返回值可观测 | `OrganizeMovieResult` | 新增 `renamedTo` / `renameConflict`，调用方可据此展示"改了/因冲突跳过" |

单测新增：`movie-file-name.test.ts`（6 例）、`link-expiry.test.ts`（3 例）、`media-organizer.test.ts` 增补重命名与冲突各 1 例。

### 10.2 设计取舍

- **不用 `deleteStrmLinkCache`**：给 `StrmStore` 接口与两个仓库实现加方法会让 `sqlite.ts` 超出棘轮行数上限（2667→2670）。改用既有 `setStrmLinkCache` 写入 `expiresAt: 0` 的墓碑条目——`getStrmLinkCache` 会因过期而返回 null，效果等价且零接口改动。
- **只重试一次**：并发 Range 请求全部 403 时，`SingleFlight` 保证只有一次真正解析；重试仍失败不写回缓存，避免"坏链接复活"。

### 10.3 实机验收（开发实例 3020）

P0 用「注入坏缓存」的方式做端到端验证（开发库，验证后自动被真实链接替换）：

| 步骤 | 操作 | 结果 |
| :--- | :--- | :--- |
| 1 | 向 `strm_link_cache` 写入 `download_url = http://127.0.0.1:3000/api/strm/play/aaa/bbb?token=bad&exp=1`（必返 401）、`expires_at = now+7200` | 写入成功 |
| 2 | `GET /api/strm/play/...&delivery=proxy`（Range 0-1023） | **206**，1024 字节，2.7s |
| 3 | 复查缓存条目 | URL 已替换为真实 `115cdn.net` 直链，TTL 7183s |

即：坏链接 → 检测 401 → 墓碑 → 重新解析 → 重试成功。旧实现会直接把这个 401 透传给播放器。

回归（同一实例）：五页巡检 + R3–R6 全 true；播放器 UX（全屏 gap 0、复制「已复制」、字幕按钮与 V 循环、偏好记忆）全通过；字幕专项全通过；HUD 三档与分段文案全通过。

### 10.4 未做与原因

| 项 | 原因 |
| :--- | :--- |
| P1 的端到端改名验证 | 需要在真实网盘上对某个影视目录执行整理（会产生 rename 副作用）。本轮以 mock 存储单测覆盖「改名」与「冲突跳过」两条路径，未对用户盘做实际改名 |
| P2 legacy 目录升级 / P3 多版本并排 / P4 dryRun 与回滚 | 本轮范围外，按 §8 计划推进 |
| 上游真实过期时间解析 | 115 downurl 响应未发现稳定过期字段；需按驱动逐个适配（ProviderExpiryAdapter） |
