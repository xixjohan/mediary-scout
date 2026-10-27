# 媒体自动化 / 网盘资源管理：业界开源方案与架构模式调研

> 调研日期：2026-10-27。调研人：软件架构调研员（子代理）。
> 用途：为「开源自部署媒体追踪工具」（Next.js + TypeScript + SQLite/better-sqlite3 +
> `packages/workflow` 领域层）做订阅逻辑、人工介入选种、网盘抽象、STRM、状态机、
> 日志页面的技术选型参考。
>
> **证据分级约定**
> - 【事实】= 有可点击的一手/准一手来源（官方 wiki、源码、npm registry、GitHub API、
>   官方文档站）支撑，本文引用原文关键句。
> - 【推断】= 我基于上述事实做的推理，明确标注，不代表来源原文。
> - 【未查证】= 想查但没查到 / 来源冲突 / 只有二手转述，明确标注，不编版本号与 API 细节。

---

## 0. TL;DR — 六个方向的一句话结论

| # | 方向 | 主流方案 | 给本项目的核心可借鉴点 | 不适用点 |
|---|---|---|---|---|
| 1 | 订阅/监控 | Sonarr / Radarr（Servarr 家族） | 「Monitored + Wanted/Missing + Cutoff Unmet」三态派生视图；Quality Profile = 允许集 + 排序 + 升级截止 + 拒绝阈值；Blocklist 永久生效；Delay Profile = 抓取前等待 | 不做「全库轮询」而做「增量 RSS 比对」的假设在国内网盘场景不完全成立 |
| 2 | 人工介入选种 | qBittorrent RSS 规则、Seerr（Overseerr 后继）、Sonarr Interactive Import | qBittorrent 的「规则 = 包含/排除 + 目标(category/savepath) + 冷却」字段集可直接照抄；Interactive Import 就是「搜索→人工勾选文件→入库」的现成先例；Seerr 的 Media / MediaRequest 双层状态 | Overseerr 已归档，勿以其为活跃基线 |
| 3 | 网盘抽象 | rclone `fs.Fs`、Alist `driver.Driver`、CloudDrive2（FUSE） | rclone「5 个必需方法 + 能力声明」与 Alist「Reader 必需 / Writer 可选 / Link 取直链 / PutURL 离线投递」两种切法；本项目 `StorageExecutor` 已经在用同款模式 | CloudDrive2 未找到官方开源仓库，驱动接口无法核对；rclone 没有「分享链接转存」抽象 |
| 4 | STRM / 虚拟库 | Emby/Jellyfin + `.strm` + 302 直链；Auto_Symlink / Symedia / CMS / alist-strm | `.strm` 内容写成「可解析重定向地址」而非「会过期的直链」是经过生产验证的关键决策 | 蓝光原盘 ISO 的元数据/分集识别不完善；不适合需要改文件的场景 |
| 5 | 状态机工程 | XState v5、Robot3、@zag-js/core；Temporal / Inngest / BullMQ / SQLite 队列 | 单机自部署：手写「状态字段 + 转移表 + 守卫」足够；引入 XState 的合理位置是前端多步向导，不是服务端编排 | Inngest 服务端 SSPL 许可 + 需 Redis；Temporal 对单机项目是数量级以上的过度设计 |
| 6 | 日志/可观测 | pino（+ 传输层落库）、Logdy（查看器）、Sonarr 的日志页 | pino 六级 + child logger + redact + worker 线程 transport；Next.js 有打包陷阱需专用插件 | Logdy 默认内存缓冲，不是聚合平台，适合作附加查看器而非唯一方案 |

---

## 1. 订阅 / 监控类：Sonarr / Radarr / Lidarr 的 Series/Movie + Wanted/Missing 模型

### 1.1 主流方案

Servarr 家族（Sonarr / Radarr / Lidarr / Readarr / Prowlarr / Whisparr）共用同一套
「元数据条目 + 监控开关 + 缺失/待升级派生视图 + 索引器 + 下载客户端 + 导入」模型。
本文只对 **Sonarr 与 Radarr** 做了一手核实；**Lidarr 未单独查证**（【未查证】——
但按 Servarr 家族同构的设计可合理推测一致，此推测未经 Lidarr 文档/源码验证）。

### 1.2 「已监控但缺失 / 已下载待导入 / 已入库」如何表达【事实】

关键点：**这三者不是三个状态字段，而是「两个布尔/枚举 + 四个派生查询」**。

派生视图定义（[Sonarr Wanted](https://wiki.servarr.com/sonarr/wanted)）：

- **Wanted ⇒ Missing** = 「你已经标记监控、且磁盘上缺失（还没下载过）的剧集」。
  原文：*"a list of the episodes you have marked to monitor that are missing from your
  disk (haven't been downloaded yet)"*，并明确 *"This will only include episodes
  completely missing from your disk, not episodes which exist on disk, but have their
  cutoff profile unmet."*
- **Wanted ⇒ Cutoff Unmet** = 「已经在磁盘上、但质量还没到 cutoff 的剧集」。
  原文：*"a list of the episodes that have not yet reached their cut off."*
- 两个页面都有 **Monitored / Unmonitored 过滤器**，且支持批量 Monitor / Unmonitor。

Radarr 的过滤器把这套语义写得更直白（[Radarr Library](https://wiki.servarr.com/radarr/library)）：

| 过滤器 | 原文定义 |
|---|---|
| Monitored Only | *"Titles being monitored for updates."* |
| Unmonitored | *"Titles NOT being monitored for updates."* |
| Missing | *"In the database, monitored, but missing from the filesystem."* |
| Wanted | *"In the database, monitored, missing, but should be available based on the availability settings"* |
| Cut-off Unmet | *"Title on filesystem, but still monitoring for wanted quality."* |

自定义过滤器里出现的原始字段（【事实】，同一来源）：`Monitored (boolean)`、
`Considered Available (boolean)`、`Minimum Availability (Enum: Announced / In Cinemas /
Released)`、`Quality Profile (Enum)`、`Size on Disk (Int)`、`Path [contains]`、`Tags`。

【推断】所以对「已入库」的表达不是 `status = imported`，而是
**「有文件记录 + Monitored 开关 + Considered Available 开关」三者组合**：
- 已入库且不再追升级 = 有文件 + Unmonitored（或 Monitored 但已满足 cutoff）
- 已监控但缺失 = 无文件 + Monitored
- 已下载待导入 = 根本不在条目表里表达，而在**队列**里表达（见 1.3）

### 1.3 Release 抓取 → 下载客户端 → 导入：阶段划分【事实】

来源：[Sonarr Quick Start Guide](https://wiki.servarr.com/sonarr/quick-start-guide)
与 [Sonarr Activity](https://wiki.servarr.com/sonarr/activity)。

链路原文要点：

1. 给下载客户端发下载请求，并打上配置的 **category/label**（如 `tv`、`movies`）。
2. 通过**下载客户端 API** 轮询该 category 下的活动下载。
3. 完成后从客户端 API 得知**最终文件位置**（可以与媒体目录不同，只要 Sonarr 能访问）。
4. 扫描该位置，**解析文件名**匹配到请求的媒体。
5. 按命名规范重命名，移动到媒体目录。
6. 默认 **Atomic Move（瞬时移动）**，要求下载目录与媒体库在同一文件系统/挂载；
   失败或不支持硬链则回退 copy + 删源。
7. BitTorrent 客户端下**保留原位供做种**，导入时**硬链**（不支持则 copy）。
8. 「Completed Download Handling - Remove」开启时，导入后请求客户端删除残留。

队列（Queue）的状态（官方 wiki 自注 *"the below is incomplete"*）：

| 状态 | 含义 |
|---|---|
| Release Pending | *"Download is awaiting Download Client to be available or for release to meet Delay Profile Rules"* |
| Warning Unable to Import | *"\*Arr was unable to import the release."* |
| Download Importing | *"Download is Importing"* |

队列动作：`X`（从队列移除 / 从客户端移除 / **Blocklist Release**）、人形图标
（**Manual Import Release**）、抓取图标（发送到下载客户端）。

**一条对架构极关键的事实**（原文）：
> *"The queue is not stored anywhere within the application, but is updated via your
> Download Client's API responses."*

【推断】也就是说：**「已下载待导入」不是持久状态，而是对外部系统的实时投影**。
导入成功/失败的结果才落库——落在 **History**（*"all things that have left the queue"*：
imports / failures / grabs / deletes / upgrades）和 **Blocklist**。

黑名单（Blocklist，官方注明 *"formerly known as 'Blacklist'"*）语义：

- *"items that are blocklisted so they won't be downloaded again"*
- *"Items remain in the blocklist forever unless you manually remove them."*
- 触发原因：用户手动标记失败；用户移除队列时选 "Add to Blocklist"；Usenet 客户端报告下载失败。
- 在 History 的 `Grabbed` 条目上点 `i` 可看详情并 *"mark this item as failed, to
  initiate a removal, blocklist, and re-search of the item."*

### 1.4 抓取策略本身：增量比对而非全库轮询【事实】

[Sonarr FAQ](https://wiki.servarr.com/sonarr/faq)：

> *"Sonarr does not regularly search for episode files that are missing... it fairly
> frequently queries your indexers and trackers for all the newly posted episodes/newly
> uploaded releases, then compares that with its list of episodes that are missing or
> need to be upgraded."*
> *"Sonarr will only find releases that are newly uploaded to your indexers. It will
> not actively try to find releases uploaded in the past."*
> *"This lets Sonarr cover a library of any size with just 10-144 queries per day
> (RSS interval of 10-120 minutes)."*
> 离线较久后 *"Sonarr will attempt to page back to find the last release it processed"*。

【推断】这条是「订阅逻辑」最重要的可借鉴/不可借鉴分界：**Sonarr 的订阅是
「增量新发布 × 缺失集合」的交集运算**，前提是索引器支持按时间倒序翻页。国内网盘
资源搜索（PanSou/磁力聚合）大多**没有可靠的增量游标**，所以本项目更可能是
「周期全量重搜 + 去重」，而非 Sonarr 式增量比对。若要借鉴，应借鉴其
**「搜索结果的指纹去重 + 已处理水位线（last processed）」**结构，而不是照搬其成本模型。

### 1.5 Quality Profile：质量/偏好如何建模【事实 + 部分二手】

官方 wiki 侧可核实的事实：

- Quality Profile 决定：允许哪些质量、排序、**是否允许升级**、**Upgrade Until**、
  **Minimum Custom Format Score**（[Sonarr Settings 目录](https://wiki.servarr.com/sonarr/settings)
  的 Profiles 小节；[TRaSH 指南](https://trash-guides.info/Sonarr/sonarr-setup-quality-profiles)
  对同一组字段有逐字段说明）。
- Custom Format = 一组条件，匹配 **release 名称**以及下载后的 **media info**；
  每个 Profile 给每个 Custom Format 一个分数；*"Custom formats that match with
  undesirable attributes should be given a negative score"*，硬拒绝用 -10000 量级。
- [Sonarr v4 FAQ](https://wiki.servarr.com/sonarr/faq-v4)：Preferred Words 被 Custom
  Formats 取代，*"custom formats can be given different levels of importance for each
  quality profile. Custom Formats can also be given a cutoff level so that upgrades
  stop happening once a desired level of preference is reached"*。
- Delay Profile 的存在由队列状态 *"awaiting ... for release to meet Delay Profile
  Rules"* 与官方 FAQ 的排序键 *"Protocol (as configured in the relevant Delay
  Profile)"* 交叉印证。
- 下载决策排序（官方 FAQ 注明 *"As of 2024-01-16"*，并说明 *"The current logic can
  always be found here"*，即以源码为准）：
  **Quality > Custom Format Score > Protocol > Episode Count > Episode Number >
  Indexer Priority > Seeds/Peers（BT）> Age（Usenet）> Size**；
  REPACK/PROPER 是同质量的 v2，排在非 repack 之上。

【推断】把这套翻译成本项目的「选种策略」：

```
SelectionPolicy {
  allowedKinds: 有序质量档位[]        // 类比 allowed qualities
  rejectRules:  { match, reason }[]   // 类比负分 Custom Format，-10000 = 一票否决
  scoreRules:   { match, weight }[]   // 类比正分 Custom Format
  minScore:     number               // 类比 Minimum Custom Format Score
  cutoff:       { kind, score }      // 类比 Upgrade Until
  preferRepack: boolean              // 类比 REPACK/PROPER
  protocolWait: { torrent|magnet|ed2k, seconds }  // 类比 Delay Profile
}
```

「黑名单」在本项目里的对应物已经天然存在：分享链接/磁力会因为失效、风控、版权下架
而**永久或临时不可用**。建议把 Blocklist 的「永久 + 可手动解除」语义原样搬过来，
并额外记录**原因分类**（官方只给了 3 类原因，本项目至少还需要：风控 429、链接过期、
转存失败、目标目录已存在同名）。

### 1.6 结论

| 可借鉴 | 不适用 / 需改造 |
|---|---|
| 派生视图而非状态爆炸（Missing/Wanted/Cutoff Unmet 全是查询） | 依赖索引器增量 RSS + 翻页的订阅模型 |
| Queue 不落库、History/Blocklist 落库的两层分离 | Usenet 专属语义（Age、NZB） |
| Blocklist 永久生效 + 可手动解除 + 记录来源 | 60 条队列深度上限等经验值（那是 Usenet 客户端特性） |
| Quality Profile 的「允许集 + 排序 + cutoff + 最小分数」四元组 | 名称解析/媒体信息（本项目面向网盘文件夹，非标准 release 命名） |
| 导入的 Atomic Move / Hardlink 优先、失败回退 copy | 本地文件系统假设（网盘无硬链，见方向 4） |

---

## 2. 人工介入的选种流程

### 2.1 qBittorrent：RSS 自动下载规则 vs 手动选种【事实】

qBittorrent 官方 wiki 的 RSS 专页在本次调研中未定位到（其 wiki Home 侧栏未列出 RSS
页面，[wiki home](https://github.com/qbittorrent/qBittorrent/wiki/) 可见）。以下字段集
来自 [qui 文档](https://getqui.com/docs/features/rss)——qui 是 qBittorrent 的第三方
WebUI，文档明确 *"qui writes all changes to qBittorrent, so they also apply in the
qBittorrent WebUI"*，并说明其规则字段 *"The document is qBittorrent's (`rss/setRule`)"*。
另可交叉参考 [qbittorrent-cli 的 rss rule 文档](https://github.com/fedarovich/qbittorrent-cli/wiki/qbt-rss-rule-add)
（同一组参数：`--contains` / `--not-contains` / `--category` / `--save-path` / `--regex`）。
【未查证】qBittorrent 上游 C++ 源码未逐行核对。

**自动下载规则字段（原文照录）**：

| 字段 | 说明 |
|---|---|
| Rule Name | *"Required. The name qBittorrent stores the rule under."* |
| Must Contain | *"Text the article title must include, for example `keyword1\|keyword2`"* |
| Must Not Contain | *"Text that excludes an article"* |
| Episode Filter | *"Season and episode ranges in the format `S01-S03;E01-E10`"* |
| Use Regex | *"Treats the contain filters as regular expressions"* |
| Smart Episode Filter | *"Tracks matched episodes and skips repeated downloads of the same episode"* |
| Affected Feeds | *"The feeds the rule applies to"* |
| Save Path | *"Save location for matched torrents"* |
| Category | *"Category for matched torrents"* |
| Tags | *"Tags for matched torrents"* |
| Ignore subsequent matches for | *"Days to ignore new matches after a match, default 0"* |
| Torrent Content Layout | *"Original, create subfolder, no subfolder, or the global qBittorrent value"* |
| Add Stopped | *"Adds matched torrents in the stopped state, or uses the global value"* |

配套机制：每条规则有 **Last Match** 时间；**Matching Articles 预览**（*"If you want to
test a filter before you enable the rule, use this preview"*）；**Reprocess rules**
（*"check all unread articles against all rules again"*，用于规则改完后回头评估旧文章）；
智能剧集过滤器还有 *"Download REPACK/PROPER"* 与逐行剧集号正则。

**手动选种与自动规则共享同一数据面**：每个 article 有 `Download torrent`（打开添加
种子对话框并预填种子 URL）与 `Open link`。也就是说 **「自动规则」和「手动逐条点」
消费的是同一个 feed 列表，只是入口不同**——这正是本项目「自动订阅 + 手动搜索/选择」
应该共用的模型。

【推断】可直接落地的三件事：
1. 规则的「冷却期」（Ignore subsequent matches for N days）对应本项目「同一媒体
   短期内不要重复推送/重复抓取」；
2. 「规则预览」对应本项目「保存策略前先用当前搜索结果试跑」——这是低成本高价值功能；
3. 「Reprocess」对应本项目「策略改完后对未处理的历史结果重放」。

### 2.2 Seerr（Overseerr 后继）：「请求 → 审批 → 可用」状态机【事实，含来源说明】

**重要事实：Overseerr 已归档。** GitHub 页面横幅显示
*"This repository was archived by the owner on Feb 15, 2026. It is now read-only."*
（[sct/overseerr](https://github.com/sct/overseerr)）；Overseerr 与 Jellyseerr 于
2026-02-10 合并为 **Seerr**（[seerr-team/seerr](https://github.com/seerr-team/seerr)，
官网 seerr.dev）。二手佐证见
[selfhostlab 的 Overseerr 条目](https://selfhostlab.io/apps/overseerr)。
**因此不要把 Overseerr 当活跃基线。**

状态枚举（`server/constants/media.ts`）。说明：以下内容来自搜索引擎对
[seerr 源码文件](https://github.com/seerr-team/seerr/blob/92c486d3124ece4379a122d004e157074175b83e/server/constants/media.ts)
与
[sleutharr 的 API 笔记](https://github.com/Dsopinka/sleutharr/blob/main/docs/api-notes.md)
的引用片段，**未直接抓取原文件逐字复核**（【未查证：原文直读】）：

```ts
export enum MediaRequestStatus { PENDING = 1, APPROVED, DECLINED, FAILED, COMPLETED }
export enum MediaStatus {
  UNKNOWN = 1, PENDING, PROCESSING, PARTIALLY_AVAILABLE, AVAILABLE, BLOCKLISTED, DELETED,
}
```

【事实，来自 seerr `server/entity/MediaRequest.ts` 引用片段】创建请求时的逻辑：
- `Media.status` 在请求创建时置 `PENDING`（非 4K 分支）；
- `MediaRequest.status` = 用户拥有 `AUTO_APPROVE` / `AUTO_APPROVE_MOVIE` /
  `MANAGE_REQUESTS` 等权限时取 `APPROVED`，否则 `PENDING`；
- 请求实体携带 `profileId`、`rootFolder`、`tags`、`is4k`、`isAutoRequest`；
- 通知事件枚举含 `MEDIA_PENDING / MEDIA_APPROVED / MEDIA_AVAILABLE / MEDIA_DECLINED /
  MEDIA_FAILED / MEDIA_AUTO_REQUESTED / MEDIA_AUTO_APPROVED`。

【推断】**双层状态是本项目最值得抄的结构**：
- `Media`（条目/媒体）：UNKNOWN → PENDING → PROCESSING → PARTIALLY_AVAILABLE →
  AVAILABLE（或 BLOCKLISTED / DELETED）——回答「这东西现在到底有没有」。
- `MediaRequest`（一次人工或自动的诉求）：PENDING → APPROVED / DECLINED →
  COMPLETED / FAILED——回答「这次诉求走到哪了」。

一次失败不该污染条目状态（FAILED 在 Request 层），条目级的 BLOCKLISTED 与 Request 级的
FAILED 分属不同生命周期。这与 Sonarr 的「Queue 不落库 / History+Blocklist 落库」
是同一思想的不同切法。

### 2.3 「搜索 → 人工勾选文件/文件夹 → 入库」的交互先例【事实】

**有，而且就在 Servarr 里，叫 Interactive Import。**

[Sonarr Wanted](https://wiki.servarr.com/sonarr/wanted) 与
[Radarr Library](https://wiki.servarr.com/radarr/library)：

- **Manual Import（Movie Index / Movie）**：*"Manually import a movie file for a movie
  you have added to Radarr from the assigned movie's folder"*。
- **Move Automatically**：*"Automatically attempt to match a file to a Movie in Radarr
  and import by moving it."*
- **Interactive Import**：*"Review all files within the path and attempt to match to a
  Movie in Radarr allowing the user to review the results. Move or Copy/Hardlink is a
  selectable option in the bottom left corner."*
- 边界：*"If a directory has more than 100 files in it then Sonarr will not recursively
  search the directory nor attempt to parse and match the files."*
- 队列里的人形图标 = **Manual Import Release**。
- Wanted 页顶部就是 Manual Import 入口，用于 *"arbitrarily import media files from any
  destination Sonarr can access"*。

【推断】这条链路和本项目「手动搜索 → 勾选文件/文件夹 → 入库/整理」几乎同构，
差异只在目的地是本地文件系统还是网盘目录。可借鉴的具体形态：
1. **先列候选（树/表），再让人确认匹配关系**，而不是让人先选再猜；
2. **导入方式（移动/复制/硬链）作为导入时的一个显式选项**呈现——网盘场景下应换成
   「转存到目标目录 / 只记录引用（STRM）/ 软链」三选一；
3. **目录文件数上限保护**（>100 不递归）——网盘列目录有速率限制，这个阈值思路必须保留；
4. 「自动匹配」与「交互式匹配」是**同一个导入器的两种模式**，不是两条代码路径。

另一类先例是网盘侧的「离线下载对话框」：Alist 的 115 驱动自 v3.37.0 起支持调用
115 离线下载，*"支持：magnet、http、ed2k 链接"*，但
*"unsupported storage driver for offline download, only 115 Cloud is supported"*
（[AList 115 驱动文档](https://alistgo.com/zh/guide/drivers/115.html)）。即
「粘贴磁力 → 选目标文件夹 → 轮询落地」已经是国内网盘工具的标准交互。

### 2.4 结论

| 可借鉴 | 不适用 |
|---|---|
| qBittorrent 规则字段集（含/排除 + 目标 + 标签 + 冷却 + 剧集过滤） | 剧集号正则解析（本项目是文件夹/文件名粗匹配） |
| 规则预览 +  Reprocess（改策略后重放历史结果） | RSS feed 模型本身（本项目是搜索 API） |
| Seerr 的 Media / MediaRequest 双层状态 + 权限自动审批 | 多用户/配额/通知体系（单机自部署可后置） |
| Sonarr Interactive Import 的「列候选 → 人确认 → 选导入方式」 | 本地 FS 假设、硬链/瞬时移动 |

---

## 3. 网盘抽象层：rclone / Alist / CloudDrive2

### 3.1 rclone：`fs.Fs` —— 「5 个必需方法 + 能力声明」【事实，源码直读】

[rclone v1.75.1 `fs/types.go`](https://github.com/rclone/rclone/blob/v1.75.1/fs/types.go)：

```go
// Fs is the interface a cloud storage system must provide
type Fs interface {
    Info
    List(ctx context.Context, dir string) (entries DirEntries, err error)
    NewObject(ctx context.Context, remote string) (Object, error)
    Put(ctx context.Context, in io.Reader, src ObjectInfo, options ...OpenOption) (Object, error)
    Mkdir(ctx context.Context, dir string) error
    Rmdir(ctx context.Context, dir string) error
}
```

`Info` 提供 `Name() / Root() / String() / Precision() / Hashes() / Features()`。
`Object` = `ObjectInfo` + `SetModTime` + `Open` + `Update` + `Remove`；
`ObjectInfo` = `DirEntry` + `Hash` + `Storable`；`DirEntry` = `Fs / String / Remote /
ModTime / Size`；`Directory` = `DirEntry` + `Items + ID`。

`types.go` 中可见的 **Object 级可选接口**：`MimeTyper`、`IDer`、`ParentIDer`、
`ObjectUnWrapper`、`SetTierer`、`GetTierer`、`Metadataer`、`SetMetadataer`、`SetModTimer`。
【未查证】Fs 级可选能力（移动/目录移动/复制/清空/公开链接等）声明在
`fs/features.go`，本文未逐条读取该文件，故不列举其成员。

`Info.Features()` 的设计意义（【推断】）：**把「这个后端支不支持某能力」变成运行时可
查询的声明**，而不是到处类型断言。第三方对 rclone 代码库的结构分析也指出其
*"required surface is kept to an absolute minimum (5 methods) ... All optional
operations are moved to the Features struct"*，且后端通过 `fs.Register(...)` 自注册
（[接口分析](https://panos-zamos.github.io/go/docs/projects/rclone/interfaces)，
二手来源）。

### 3.2 Alist：`driver.Driver` —— 「Reader 必需 / Writer 可选 / Link 取直链 / PutURL 离线投递」【事实，源码直读】

[Alist main `internal/driver/driver.go`](https://raw.githubusercontent.com/AlistGo/alist/main/internal/driver/driver.go)：

```go
type Driver interface { Meta; Reader }                 // Writer/Other 被注释掉，即非必需
type Meta interface { Config(); GetStorage(); SetStorage(); GetAddition(); Init(ctx); Drop(ctx) }
type Other interface { Other(ctx, args model.OtherArgs) (interface{}, error) }

type Reader interface {
    // List files in the path
    List(ctx context.Context, dir model.Obj, args model.ListArgs) ([]model.Obj, error)
    // Link get url/filepath/reader of file
    Link(ctx context.Context, file model.Obj, args model.LinkArgs) (*model.Link, error)
}
```

写操作全部是**独立可选接口**：`Mkdir(MakeDir)`、`Move`、`Rename`、`Copy`、`Remove`、
`Put`、`PutURL`，以及对应的 `*Result` 变体（返回新 Obj）、`ArchiveReader` /
`ArchiveGetter` / `ArchiveDecompress(_Result)`、`GetRooter`、`Getter`、`Reference`。

其中两段注释对本品项目极关键（原文）：

- `Link`：*"Link get url/filepath/reader of file"* —— **「取直链」是一等方法公民**，
  而不是附加功能。这正是 STRM/302 方案的接口基础。
- `PutURL`：*"PutURL directly put a URL into the storage — Applicable to index-based
  drivers like URL-Tree or drivers that support uploading files as URLs. Called when
  using SimpleHttp for offline downloading, skipping creating a download task"*
  —— **「把 URL 直接投递成存储里的文件」被显式建模为一种能力**，与「下载到本地再上传」
  是两条路。

`Put` 的注释还规定了三件工程责任：**取消（ctx / 限速读流）、实时进度上报、上传限速**，
并提醒分片并行上传要用信号量限制并发以防内存膨胀。

**Alist 的驱动目录（[AList 文档侧栏](https://alistgo.com/zh/guide/drivers/115.html)）
本身就是一份「存储后端抽象」的活教材**，其中与本品项目强相关的类型：

- 分享类：`115 网盘 / 分享`、`阿里云盘 / 分享`、`OneDrive / 分享`、
  `123网盘 / 分享 / 直链`、`百度分享`、`PikPak / 分享`、`Cloudreve V4 / 分享`
- 虚拟/派生类：`地址树(URL-Tree)`、`STRM`、`Chunker（分片）`、`Crypt(加密)`、
  `alias别名`
- 以及 70+ 真实网盘/协议驱动

【推断】**「分享链接」在 Alist 的世界里是一个只读 Driver，不是一种特殊操作。**
这一点与 rclone 形成鲜明对比（见 3.4），也是本项目最值得模仿的决策：
把 `ShareSource` 做成 `StorageExecutor` 的一个**只读子集能力**（`list` + `link` +
`transferFromShare`），而不是在 `transfer()` 里加一个 `kind: 'share' | 'magnet'` 分支。

### 3.3 分享链接驱动的实现细节【事实，源码直读】

[OpenListTeam/OpenList v4.2.1 `drivers/aliyundrive_share/driver.go`](https://github.com/OpenListTeam/OpenList/blob/v4.2.1/drivers/aliyundrive_share/driver.go)：

- 驱动结构体：`model.Storage` + `Addition` + `AccessToken` + `ShareToken` + `DriveId` + cron。
- `Init` 里 `refreshToken()` + `getShareToken()`，并用 `cron.NewCron(time.Hour * 2)`
  每 2 小时续期；`limitList`/`limitLink` 用 `rateg.LimitFnCtx` 做**令牌桶限流**
  （List 4/s、Link 1/s）。
- `Link()` 请求 `https://api.alipan.com/v2/file/get_share_link_download_url`，body 为
  `{drive_id, file_id, expire_sec: 600, share_id}`，带 `CanaryHeaderKey` 头，
  返回 `model.Link{Header: {"Referer": "https://www.alipan.com/"}, URL: resp.DownloadUrl}`。

[AlliotTech/openalist 同名驱动](https://github.com/AlliotTech/openalist/blob/9a5a1d41e1a2/drivers/aliyundrive_share/driver.go)
结构一致（额外带 `ShareId` 字段）。

AList 115 驱动的分享模式（[文档](https://alistgo.com/zh/guide/drivers/115.html)）：

- 「115网盘分享」需要三项：**分享链接ID**、**分享链接提取码**、**根文件夹ID**
  （*"默认为空，挂载整个目录文件"*；另有子文件夹 ID 可缩小范围）。
- 个人盘模式支持二维码登录（多设备类型：web/android/ios/tv/alipaymini/wechatmini/qandroid），
  并提醒 *"不推荐选择 Web、android 或 ios，因为使用常用设备登录后可能会将原有登录状态挤下线"*。
- **秒传**：*"可以直接通过复制方式来和阿里云盘Open进行相互秒传文件"*——即**同源哈希
  秒传是「复制」语义的上游优化，不是独立 API**。
- 115 分享直链的民间实现思路（[issue #5384](https://github.com/AlistGo/alist/issues/5384)）：
  分享文件用 `POST https://proapi.115.com/app/share/downurl`，参数 RSA 加密
  `{share_code, receive_code, file_id}`；文件列举用
  `GET https://webapi.115.com/share/snap`。
  【未查证】该 issue 中的接口细节未经官方文档确认，仅作为「分享链路与自盘链路是
  两套端点」的证据。

### 3.4 「分享链接转存」在三家的实现差异【事实 + 推断】

| | Alist / OpenList | CloudDrive2 | rclone |
|---|---|---|---|
| 分享链接的建模 | **只读 Driver**（`aliyundrive_share` 等），`List` + `Link` | 挂载成本地目录后按普通文件操作 | **无通用 share-URL remote** |
| 转存动作 | 在自己的盘上挂第二个 storage，然后 `Copy`（或秒传） | 挂载点之间/挂载点与本地之间 `cp` | `rclone copy remoteA: remoteB:` |
| 磁力/ed2k | 驱动级离线下载（**仅 115 Cloud 驱动支持**，支持 magnet/http/ed2k） | 上传/下载任务队列 | 无（需外部客户端） |
| 直链获取 | `Link()` 一等方法，返回 `*model.Link{URL, Header}` | 本地路径即「直链」（经 FUSE） | `rclone link` 只做**创建/删除公开链接**，非取流 |

rclone 侧的两个可引用事实：
- [`rclone link` 文档](https://github.com/rclone/rclone/blob/master/docs/content/commands/rclone_link.md)：
  *"Create, retrieve or remove a public link to the given file or folder."*，且
  *"not all backends support the --expire flag"* / *"--unlink"*。
- rclone **没有**「把一个第三方分享 URL 当 remote 拉取」的能力：
  [Dropbox shared links issue #6608](https://github.com/rclone/rclone/issues/6608)
  明确提出该缺口，并描述 Dropbox 分享链接在浏览器里只有 Download（打包 zip）或
  Save to Dropbox（*"creates a local copy of the share ... detached from the original
  share, uses one's own quota and won't be updated with changes"*）。Google Drive 是
  例外，有 `--drive-shared-with-me`（[forum 引用官方参数说明](https://forum.rclone.org/t/gsuite-drive-shared-with-me-not-working-when-used-in-config/10602)：
  *"Only show files that are shared with me ... Config: shared_with_me"*）。

CloudDrive2 的架构事实（[部署文档](https://github.com/SeanChang/xuanyuan_docker_proxy/blob/main/blog/clouddrive2-docker-deploy.md)，
社区维护镜像 `cloudnas/clouddrive2`）：
- 形态 = 浏览器加盘 → FUSE 挂到容器内 `/CloudNAS` → 通过 Docker 卷 `:shared`
  传播到宿主机，*"让你在宿主机上像操作本地硬盘一样读、写、扫库"*；
- 依赖 `privileged` + `/dev/fuse` + `MountFlags=shared` / `mount --make-shared`；
- 配置与缓存在 `/Config`。
【未查证】**未找到 CloudDrive2 官方开源源码仓库**（只找到安装脚本 fork 与镜像），
因此其驱动接口无法核对，本文不对其内部接口下任何结论。

### 3.5 对本项目的映射（【推断】，基于已读代码）

本项目 `packages/workflow/src/ports.ts` 的 `StorageExecutor` 已经具备同款形态：
必需方法少（createDirectory / listVideoFiles / renameFile / transfer /
flattenDirectory / deleteFiles / removeDirectory / listTree / listSubdirectories /
listChildDirectories / moveFiles），可选能力用 `?` 方法做**能力门控**
（`transferSubtitleUrl?` 的注释明确写着它是 *"the capability gate: the orchestrator
enables the whole subtitle flow iff this method exists on the executor"*）。
这正是 rclone `Features()` / Alist 可选接口的同款思想，且用 TS 的 `?` 表达得更轻。

建议补齐的三个缺口（对照 3.2/3.3）：

1. **`link(file): { url, headers, expiresAt } | undefined`** —— 目前没有取直链能力，
   这直接堵死了 STRM/302 方案（见方向 4）。阿里分享驱动的 `expire_sec: 600` 说明
   **直链是短寿的**，接口必须允许返回 `expiresAt`。
2. **`putUrl(url, name, dir)`** —— 对应 Alist 的 `PutURL` 语义（磁力/http/ed2k 走
   网盘自己的离线下载，不经过本机带宽）。本项目已有 `transferSubtitleUrl?`，
   说明这条路已经走通一半，应把它泛化而非特化在字幕上。
3. **只读 `ShareSource` 能力**（`list` + `link` + `resolveShare`），让「分享链接」
   成为一种可枚举、可预览、可选择的输入源，而不是 `transfer()` 的一个分支参数。

---

## 4. STRM / 虚拟库

### 4.1 主流方案与事实

`.strm` 的定义（[知乎专栏](https://zhuanlan.zhihu.com/p/1943793195491234280)）：
> *"STRM 文件是一种简单的文本文件，其文件扩展名为 .strm。它内部只包含一个指向媒体文件
> （如视频、音频）的 URL 链接，而不是媒体数据本身。当 Emby、Jellyfin 或 Kodi 等媒体
> 服务器播放 STRM 文件时，它会读取其中的链接并直接通过网络进行流媒体播放。"*

302 直链播放（同来源）：
> *"当媒体服务器请求一个STRM文件中的链接时，服务器（如Alist、Openlist）会返回一个302
> 状态码和一个新的Location头（指向网盘中的真实文件链接），媒体服务器便会跳转到这个直链
> 进行播放 ... 节省了服务器的带宽和存储成本。"*

动机（[CSDN 教程](https://blog.csdn.net/qq_63499861/article/details/146411300)）：
> *"防止网盘风控：这个应该是我们NAS玩家折腾Strm最重要的原因了，因为如果我们使用NAS的
> 播放器直接对网盘中的影视文件进行整理和刮削时，频繁扫库会触发网盘运营商的风控策略，
> 严重的封号也有可能。"*
另有「提高访问速度」「节省本地存储」。

**最关键的设计决策（[media-archivist 文档](https://github.com/LeMetadatarr/media-archivist/blob/dev/docs/jellyfin.md)）**：
`.strm` 的 body 有两种写法，第二种专为**会过期的 URL** 设计：

| body 写法 | 适用场景 |
|---|---|
| 直接流 URL（源站已公开） | 源本身给公开 MP4/MP4 |
| `<base_url>/strm/<entry_id>`（间接） | *"Indirect via `media-archivist serve`. The server resolves at request time and returns the current URL. Useful for sources whose URLs expire (YouTube)."* |

这与阿里分享驱动 `expire_sec: 600`（10 分钟）的事实互为印证：**把会过期的直链写进
`.strm` 是一个会腐烂的设计**。

生态工具（[知乎](https://zhuanlan.zhihu.com/p/1943793195491234280)对
Auto_Symlink / Symedia / CMS / alist-strm / SmartStrm 的横向梳理）共同形态：
- 监听 CloudDrive2 的 inotify/webhook 或轮询 115 事件 API，*"新增/删除/改名文件 3–10
  秒内即可在本地同步更新软链接或 .strm"*；
- 把「远端路径 ↔ pickcode / 挂载路径」映射写进**本地 SQLite**，播放时实时换直链；
- 元数据（nfo/jpg/字幕）落到本地，不碰云端；
- 变更后调用 Emby/Plex 的 `/Library/Refresh`；
- 定时清理失效链接。

### 4.2 对「网盘入库」意味着什么（【推断】）

把「入库」拆成三个可独立选择的层次，本项目可以按品牌/按用户勾选：

| 层次 | 做法 | 代价 | 适配场景 |
|---|---|---|---|
| L1 实体落地 | 转存到网盘目标目录（本机/网盘间 copy） | 占网盘容量 + 转存耗时 | 默认路径，便于二次整理、改文件名 |
| L2 软链/STRM | 本地生成 `.strm` 或 symlink，指向网盘直链 | 本地几 KB；依赖直链可用性 | 大库、只读消费、规避风控 |
| L3 仅记录 | DB 里存分享链接 + pickcode，不产生任何本地文件 | 无本地产物 | 「先标记后处理」的队列态 |

L2/L3 的关键前提是**有 `link()` 能力和映射表**——这又回到 3.5 的建议 1。
Symedia/CMS 的「远端路径 ↔ pickcode 落 SQLite」结构可以直接照搬：一张
`resource_link` 表，字段至少含 `provider`、`remote_path`、`pickcode_or_file_id`、
`last_resolved_at`、`last_error`，让「解析失败」成为可观测、可重试的状态。

### 4.3 STRM vs 硬链/软链的取舍【事实 + 推断】

rclone 的官方表述（[vfs.md](https://github.com/rclone/rclone/blob/master/vfs/vfs.md)）：
> *"By default the VFS does not support symlinks. However this may be enabled with
> either of the following flags: `--links` / `--vfs-links` — Translate symlinks
> to/from regular files with a '.rclonelink' extension."*
> *"As most cloud storage systems do not support symlinks directly, rclone stores the
> symlink as a normal file with a special extension. So a file which appears as a
> symlink `link-to-file.txt` would be stored on cloud storage as
> `link-to-file.txt.rclonelink` and the contents would be the path to the symlink
> destination."*

【推断】取舍表：

| | 硬链 | 软链（symlink） | `.strm` |
|---|---|---|---|
| 本地磁盘占用 | 0（同 FS） | ~0 | ~0 |
| 跨文件系统/挂载 | **不可用** | 可用 | 可用 |
| 网盘侧支持 | 无 | 基本无（rclone 用 `.rclonelink` 文件模拟） | 无需网盘支持（文本在本地） |
| 播放路径 | 直接本地读 | 本地读 → 打到挂载点 → 走网盘 API | 播放器直接 HTTP 取流 |
| 腐烂风险 | 无 | 挂载点失效即失效 | **直链过期即失效**（除非间接解析） |
| 可改名/可整理 | 是（同一 inode） | 改链接不影响目标 | 改文件内容即可 |

Sonarr 侧的对应事实：硬链是其默认优化（*"A hard link will allow not use any
additional disk space"*，同一文件系统失败则回退 copy；BT 场景默认硬链、Usenet 场景
默认瞬时移动）。**网盘没有硬链语义**，所以本项目不应把「硬链优先」当作默认策略，
而应把「转存（L1）/ 引用（L2/L3）」作为一等策略选择——这也正是 Sonarr Interactive
Import 把 *"Move or Copy/Hardlink is a selectable option"* 交给用户的原因。

STRM 的已知缺陷（[hiripple 实践记录](https://hiripple.com/zh/blog/2024-12-29-strmemby%E6%97%A0%E7%97%9B%E5%88%AE%E5%89%8A%EF%BC%8C%E5%BA%94%E5%AF%B9%E7%BD%91%E7%9B%98%E9%A3%8E%E6%8E%A7%E6%96%B0%E7%AD%96%E7%95%A5)）：
> *"ISO 的媒体信息提取并不完善，对于TV剧集，目前也无法区分每一集的视频流，只能存储
> MKV 格式的蓝光Remux。"*

即：**原盘 ISO + 剧集场景是 STRM 的明确短板**，本项目若面向原盘需谨慎。

---

## 5. 状态机工程实践（TypeScript 生态）

### 5.1 显式 FSM 库现状（版本号均取自 npm registry / GitHub API，【事实】）

| 库 | 版本/状态 | 许可 | 来源 |
|---|---|---|---|
| `xstate` | **5.33.3**，MIT | 仓库 `statelyai/xstate` 未归档，最近推送 2026-10-26，30.3k stars | [npm](https://registry.npmjs.org/xstate/latest) / [GitHub API](https://api.github.com/repos/statelyai/xstate) |
| `robot3` | **1.4.0**，BSD-2-Clause | `matthewp/robot` 未归档，最近推送 2026-10-05，2.2k stars | [npm](https://registry.npmjs.org/robot3/latest) / [GitHub API](https://api.github.com/repos/matthewp/robot) |
| `@zag-js/core` | **1.46.0**，MIT，2026-10-11 发布 | 描述为 *"A minimal implementation of xstate fsm for UI machines"* | [npm](https://npmjs.com/package/@zag-js/core) |

`@zag-js/core` 的能力边界（npm 页面原文，【事实】）：
> *"Features: Finite states with optional nested (hierarchical) states; Initial state;
> Transitions (object or strings); Context; Entry actions; Exit actions; Transition
> actions; Effects; Boolean guard helpers (and, or, not)."*
> *"The core package is intentionally minimal. It doesn't include delayed transitions,
> interval scheduling, spawn helpers, or activities."*

注意两点（【事实/未查证混合】）：
- 包名是 `@zag-js/core`，**`@zag-js/state-machine` 在 npm 上不存在**（我请求该包名
  返回 404）。zag 仓库同时出现在 `chakra-ui/zag` 与 `saas-js/zag` 两个组织下
  （[saas-js/zag](https://github.com/saas-js/zag)、[chakra-ui/zag](https://github.com/chakra-ui/zag)），
  【未查证】两者关系（迁移/镜像/fork）未经核实。
- **XState v6 处于 alpha**。依据是 day8/re-frame2 的
  [EP-0029](https://github.com/day8/re-frame2/blob/main/docs/EP/EP9-xstate-v6-machine-parity.md)，
  该文档称 *"XState v6 alpha changes the shape of XState's machine API. It removes
  many v5 helper creators, makes schemas more central, adds explicit timeouts and
  choice states"*，并列明被移除的 `assign/sendTo/raise/enqueueActions/and/or/not/stateIn`
  与 `types: {}` → `schemas`、`interpret` → `createActor` 等变化。
  【未查证】该 EP 是对 v6 的第三方解读，**未在 XState 官方仓库/发布页核实**；
  若项目要跟进 v6，务必先看官方 changelog。

### 5.2 什么规模值得引入显式 FSM（【推断】，附判据）

判据不是「状态数」，而是**下面三条同时成立几条**：

1. **存在非法转移需要被禁止**（而不是只靠 UI 不展示按钮）；
2. **同一事件在不同状态下行为不同**（≥3 个状态对同一事件有不同反应）；
3. **需要可持久化 + 可恢复 + 可审计**（进程重启后必须从上次的状态继续）。

对本品项目逐条套：

- **值得上显式 FSM 的**：人工介入的获取流程。它同时满足三条：
  `已选种 → 已暂存 → 校验中 → 待人工确认 → 导入中 → 已入库 / 整理失败 / 已拦截`，
  且「取消」「重试」「跳过」在不同阶段的语义完全不同，还必须跨进程重启恢复
  （转存是长任务，必然跨重启）。
- **不值得的**：资源搜索结果的生命周期（search → snapshot → candidate → attempt）
  本质是流水线，用「状态字段 + 阶段函数」更自然；网盘账号的
  active/frozen（本项目 `connected_storages.status` + `frozen_reason` + `frozen_at`
  已经是这个形态）也用不着 FSM。

### 5.3 推荐的落地形态（【推断】）

与其引库，不如先落一张**转移表**——它同时是文档、是校验、是可视化来源：

```ts
// packages/workflow/src/acquisition-machine.ts（示意，非现有代码）
export const ACQUISITION_TRANSITIONS = {
  selected:      { stage: 'staging', reject: 'blocked', cancel: 'cancelled' },
  staging:       { verify: 'verifying', fail: 'staging_failed', cancel: 'cancelled' },
  verifying:     { needReview: 'awaiting_review', pass: 'importing', fail: 'verify_failed' },
  awaiting_review: { approve: 'importing', reject: 'blocked', edit: 'staging' },
  importing:     { done: 'imported', fail: 'import_failed' },
  imported:      { organize: 'organizing', reopen: 'staging' },
  organize_ok: 'done', *_failed: { retry: 'staging', block: 'blocked' },
} as const;
```

好处：可单测、可序列化成前端展示、可在 SQLite 里存一个 `state` 列 + 一个
`state_entered_at` 列，天然获得「卡在某一状态多久了」的可观测性。
**若将来确实需要可视化/actor 语义，再把这张表翻译成 XState machine**
（`states`/`on` 与上表几乎一一对应），迁移成本低。

本项目已有 `packages/workflow/src/sqlite-queue.ts`：`sys_queue_jobs.status` 用
`CHECK(status IN ('queued','running','succeeded','failed','dead_letter'))` 约束，
`BEGIN IMMEDIATE` + `UPDATE ... RETURNING` 原子认领，`10s × (retry_count + 1)` 退避，
达 `max_retries` 进死信。**这已经是正确的海拔**，不要为它引入状态机库。

### 5.4 工作流/编排引擎：自部署单机场景【事实 + 推断】

| 方案 | 模型 | 自部署代价 | 许可 | 结论 |
|---|---|---|---|---|
| **Temporal** | durable execution，历史事件重放 | 服务端 + Postgres/MySQL/Cassandra；高级检索还要 Elasticsearch；单执行历史上限 50,000 事件 / 50MB，超限需 Continue-As-New；workflow 代码必须确定性，改版要用 patching API | MIT（服务器） | 【推断】单机自部署媒体工具用它是数量级以上的过度设计 |
| **Inngest** | 事件驱动 + `step.run()` 记忆化，HTTP 回调进你的应用 | 自 1.0 起支持自部署；CLI 单二进制包含全部服务；`docker pull inngest/inngest`；需要 Redis（默认 SQLite，可切 Postgres） | **服务端 SSPL-1.0 + Apache-2.0 未来许可**（已从仓库 `LICENSE.md` 直读核实）；SDK 许可【未查证】 | 【推断】许可与「需要多跑一个带 Redis 的进程」两点，对单机 SQLite 项目都不划算 |
| **BullMQ** | Node 库 + Redis 队列 | 只需 Redis，但 Redis 需配持久化 + `noeviction`；多步状态要自己建模；可观测性靠 Bull Board 等外挂 | MIT | 【推断】多步状态自己建模 = 重新发明状态表，而本品项目已经有状态表 |
| **SQLite 原生队列**（本项目 `sqlite-queue.ts`；生态同类：`vardiya`、`izi-queue`） | 一张表 + 原子认领 + 退避 + 死信 | 零额外进程 | 各自许可 | 【推断】**这就是本品项目的正解** |

两个 SQLite 队列生态参考（【事实，来自其文档，均为较新/小众项目，成熟度未经生产验证】）：
- [`vardiya`](https://npmjs.com/package/vardiya)：单依赖 `better-sqlite3`，WAL，
  `UPDATE ... RETURNING` 原子认领，重试退避、延迟、优先级、5 字段 cron、停滞任务回收、
  死信；要求 Node ≥ 22；自述 *"If you need many app servers claiming from one logical
  queue across machines, use Redis or Postgres"*。
- [`izi-queue`](https://github.com/iagocavalcante/izi-queue)：Oban 启发，支持
  Postgres/SQLite/MySQL 适配器， leader election + *"State Machine — Job state
  transitions with validation, arbitrated by the database"*，重试曲线
  `attempt^4 + 15 + rand(0..10) * attempt` 秒。

【推断】本项目 `sqlite-queue.ts` 与 `vardiya` 的设计高度一致（同样的
`UPDATE ... RETURNING` 原子认领、同样的一行 `CHECK` 状态约束），说明路线已经被验证；
**不建议替换**，只建议补两件 `vardiya` 有而它可能没有的东西：**停滞任务回收**
（`locked_at` 已存在，加一个超时判定即可）与**延迟/定时任务的 cron 表达**
（`next_run_at` 已存在，缺的是「周期性投放」的调度器）。

---

## 6. 日志 / 可观测

### 6.1 结构化日志：pino 的现状与要点【事实，官方文档 + 多篇实践】

- **六级**：`trace 10 / debug 20 / info 30 / warn 40 / error 50 / fatal 60`，
  外加 `silent`（Infinity）；默认 `info`（[pino 实践](https://axonbuild.com/blog/pino-logging)）。
- **一行一个 JSON 对象**，`base` 注入 service/env 等全局上下文，
  `pino.stdTimeFunctions.isoTime` 出 ISO-8601 UTC（[hirenodejs 2026 实践](https://hirenodejs.com/blog/nodejs-pino-logging-production-2026)）。
- **child logger** 绑定请求级上下文（`request_id` 等）；官方警告
  *"never build a child from a user-supplied object, because its keys become top-level
  fields that can collide with `level`, `time` or `msg`"*。
- **`redact`** 在写出行之前脱敏（`req.headers.authorization`、`*.password`、`*.token` 等）。
- **transport 跑在 worker 线程**，主线程不阻塞；可用 `targets` 多路输出
  （如 `pino-loki` + `pino-roll` 兜底）。
- **`pino-pretty` 只能开发用**：*"We recommend against using pino-pretty in production
  and highly recommend installing pino-pretty as a development dependency."*；
  二手实测称生产开启会掉 20–30 倍吞吐（【未查证：具体倍数】）。
- `pino/file` 在目录不存在时会抛错，除非 `mkdir: true`。

**Next.js 专属陷阱（【事实】，官方文档）**：pino **不能被直接打包**，bundler 场景需要
`pino-webpack-plugin` / `esbuild-plugin-pino` / `bun-plugin-pino` 生成 transport 文件。
本项目是 Next.js，这一点必须在引入前验证（尤其 `next build` 的独立构建阶段）。

### 6.2 单机自部署的日志页主流做法【事实 + 推断】

业界先例（Servarr）：
- [Sonarr Settings](https://wiki.servarr.com/sonarr/settings) 目录里有
  **General → Logging**（含 console log level、log 文件）与 **General → Analytics**；
- [Sonarr System](https://wiki.servarr.com/sonarr/system) 有 **Status / Health**
  分区，其中 Download Clients 健康检查会明确说
  *"Sonarr has decided to temporarily stop querying the download client on its normal
  1 minute cycle"*。
【推断】Servarr 的做法是「**日志文件 + UI 查看器 + 健康检查面板**」三件套，
而不是把日志全塞进数据库。这与本项目的定位（单机、SQLite）可以折中：

推荐形态（【推断】）：
1. **pino 作为唯一 logger**，`level` 走环境变量，`redact` 脱敏 cookie/token
   （本项目 `.env.example` 里有大量 pan115/quark/123 的凭据，日志泄漏风险真实存在）。
2. **双落点**：`pino-roll` 写滚动文件（排障用）+ 一个自定义 transport（或极薄的
   `write` 同步调用）把 **INFO 及以上的领域事件**写进 SQLite 的 `sys_logs` 表。
   只入库「事件」，不入库「调试行」——避免 SQLite 被日志撑爆。
3. **日志页 = 普通的分页查询 + 过滤器**：level / 模块 / 时间范围 / `entity_type` +
   `entity_id`（如 `workflow_run`、`connected_storage`、`resource_snapshot`）。
   关键交互是**从任一条业务记录跳到它的日志**（反向链接）。
4. **保留「日志即事件流」的能力**：本项目的 `sqlite-queue` 已有 `retry_count` /
   `error_message` / `updated_at`，日志页直接把这些暴露出来，比另起一套更省事。

轻量外部查看器备选（【事实】）：[Logdy](https://github.com/logdyhq/logdy-core)，
*"Zero-dependency single binary"*、*"Embedded Web UI"*、多输入（files/stdin/sockets/
REST）、TypeScript 自定义 parser 与列；但自述定位是交互式查看，
*"it is not a full log aggregation/SIEM platform"*，且
*"Stores logs in an in-memory buffer by default"*。
【推断】适合作 `tail -f` 的 Web 化替代，不适合作为本项目日志页的实现基础。

---

## 7. 结合本项目现状的具体建议（均为【推断】）

以下判断基于本次实际读到的代码：`packages/workflow/src/ports.ts`（`StorageExecutor`）、
`sqlite-queue.ts`、`db-schema.ts`，以及仓库中既有的
`staging-janitor.ts` / `staging-recovery.ts` / `season-sync.ts` / `user-requests.ts` /
`storage-executor-factory.ts` / `docs/refactoring-architecture-and-design-patterns.md`。

### 7.1 订阅逻辑

1. **不要建 `subscription.status` 状态机**。建「监控目标表 + 派生查询」：
   `monitored`（bool）、`availability_policy`（类比 Minimum Availability 的
   Announced/In Cinemas/Released，可映射为「只要有/要完整包/要指定质量」）、
   `last_searched_at`、`last_hit_at`。缺失/待升级/已入库全部是查询。
2. **抓取策略独立成表**（类比 Quality Profile）：
   `allowed_kinds[]`（有序）、`reject_rules[]`、`score_rules[]`、`min_score`、
   `cutoff`、`prefer_repack`、`cooldown_seconds`（借 qBittorrent 的
   "Ignore subsequent matches for"）。**策略与监控目标解耦**，才能复用。
3. **黑名单表**：`(provider, resource_key)` 唯一 + `reason` 枚举 + `blocked_at` +
   `manual`（bool，手动可解除；自动的默认永久，同 Sonarr）。
4. **节奏**：承认国内源没有可靠增量游标，用「周期全量 + 结果指纹去重 + 每目标
   最短间隔（cooldown）」控制成本；把 `resource_snapshots` 的内容哈希作为水位线
   （`ports.ts` 里 PanSou 的 run-scoped id 注释已经在处理同一问题的另一面）。

### 7.2 人工介入选种

1. **共享数据面**：自动订阅与手动搜索必须走同一个 `ResourceSnapshot` /
   `ResourceCandidate` 结构，正如 qBittorrent 的规则与手动点击共用 article 列表。
2. **策略预览**：保存/编辑策略时，用当前搜索结果「试跑」并高亮命中/拒绝原因
   （qBittorrent 的 Matching Articles 预览 + Sonarr 的 blocklist reason）。
3. **选种交互**照 Sonarr Interactive Import：
   列候选（树）→ 人确认匹配 → 选导入方式（转存/STRM/仅记录）→ 执行。
   并实现「目录文件数 > N 不递归」的保护。
4. **双层状态**照 Seerr：`media`（条目）/ `request`（一次诉求）分开，
   `FAILED` 落在诉求层，`BLOCKLISTED` 落在条目层。

### 7.3 状态机重构

- 只在**人工介入获取流程**上引入显式转移表（见 5.3），其余用状态字段 + 守卫。
- 迁移路径：先写转移表 + 单测 → 再把散落的 `if (status === ...)` 换成
  `assertTransition(from, event, to)` → 需要可视化时再翻成 XState。
- **不要**引入 Temporal / Inngest / BullMQ；`sqlite-queue.ts` 已够，
  只补停滞回收与周期调度。

### 7.4 网盘抽象

- 保持 `StorageExecutor` 的「必需少 + 可选能力门控」现状（这正是 rclone/Alist 的做法）。
- 新增三个可选能力：`link()`（返回 `expiresAt`）、`putUrl()`（泛化
  `transferSubtitleUrl`）、只读 `ShareSource`（分享链接作为可枚举输入源）。
- 「分享链接转存」建模为 `ShareSource → resolve → 目标盘 putUrl/copy`，
  而不是 `transfer({ kind: 'share' })`。

### 7.5 STRM

- 若要支持：`.strm` 内容写**自有重定向地址**（media-archivist 的间接形态），
  不写网盘直链；配一张 `resource_link` 映射表（远端路径 ↔ file_id/pickcode ↔
  最近解析时间 ↔ 最近错误）。
- 明确告知原盘 ISO 场景的短板；剧集/单文件 MKV 优先。
- 与硬链/软链的取舍交给用户在导入时选（Sonarr 的 Move/Copy-Hardlink 先例）。

### 7.6 日志页

- pino + `pino-roll`（文件）+ 自定义 transport（SQLite，只落 INFO+ 事件）。
- 表：`sys_logs(ts, level, module, event, entity_type, entity_id, message, data_json)`。
- 前端：level/module/时间范围/实体 过滤 + 分页 + 深链。
- **引入前必须验证 Next.js 打包**（pino transport 需专用 bundler 插件）。

---

## 8. 来源清单

**Servarr 官方 wiki（一手）**
- Sonarr Wanted — https://wiki.servarr.com/sonarr/wanted
- Sonarr Activity（Queue/History/Blocklist） — https://wiki.servarr.com/sonarr/activity
- Sonarr Quick Start Guide（下载→导入链路） — https://wiki.servarr.com/sonarr/quick-start-guide
- Sonarr Settings（Profiles/Download Clients/Logging 目录） — https://wiki.servarr.com/sonarr/settings
- Sonarr FAQ（抓取机制与下载决策排序） — https://wiki.servarr.com/sonarr/faq
- Sonarr v4 FAQ（Preferred Words → Custom Formats） — https://wiki.servarr.com/sonarr/faq-v4
- Sonarr System（Status/Health） — https://wiki.servarr.com/sonarr/system
- Radarr Library（过滤器与 Manual Import） — https://wiki.servarr.com/radarr/library
- TRaSH Guides：Quality Profiles — https://trash-guides.info/Sonarr/sonarr-setup-quality-profiles

**qBittorrent / Seerr**
- qui RSS 文档（qBittorrent 原生 RSS 规则字段） — https://getqui.com/docs/features/rss
- qbittorrent-cli rss rule 文档（同组参数） — https://github.com/fedarovich/qbittorrent-cli/wiki/qbt-rss-rule-add
- qBittorrent wiki Home — https://github.com/qbittorrent/qBittorrent/wiki/
- sct/overseerr（已归档 2026-02-15） — https://github.com/sct/overseerr
- seerr-team/seerr `server/constants/media.ts` — https://github.com/seerr-team/seerr/blob/92c486d3124ece4379a122d004e157074175b83e/server/constants/media.ts
- seerr `server/entity/MediaRequest.ts` — https://github.com/seerr-team/seerr/blob/v3.4.1/server/entity/MediaRequest.ts
- sleutharr API 笔记（状态枚举逐变体差异） — https://github.com/Dsopinka/sleutharr/blob/main/docs/api-notes.md
- Overseerr 归档与 Seerr 合并（二手） — https://selfhostlab.io/apps/overseerr

**网盘抽象**
- rclone `fs/types.go` v1.75.1 — https://github.com/rclone/rclone/blob/v1.75.1/fs/types.go
- rclone VFS 文档 — https://github.com/rclone/rclone/blob/master/vfs/vfs.md
- rclone `link` 命令文档 — https://github.com/rclone/rclone/blob/master/docs/content/commands/rclone_link.md
- rclone 接口结构分析（二手） — https://panos-zamos.github.io/go/docs/projects/rclone/interfaces
- rclone Dropbox shared links issue #6608 — https://github.com/rclone/rclone/issues/6608
- Alist `internal/driver/driver.go` — https://raw.githubusercontent.com/AlistGo/alist/main/internal/driver/driver.go
- Alist 115 网盘/分享 驱动文档 — https://alistgo.com/zh/guide/drivers/115.html
- OpenList `drivers/aliyundrive_share/driver.go` — https://github.com/OpenListTeam/OpenList/blob/v4.2.1/drivers/aliyundrive_share/driver.go
- openalist 同名驱动 — https://github.com/AlliotTech/openalist/blob/9a5a1d41e1a2/drivers/aliyundrive_share/driver.go
- 115 分享链接直挂实现思路（issue） — https://github.com/AlistGo/alist/issues/5384
- CloudDrive2 Docker 部署（社区镜像，非官方源码） — https://github.com/SeanChang/xuanyuan_docker_proxy/blob/main/blog/clouddrive2-docker-deploy.md

**STRM / 虚拟库**
- media-archivist：Jellyfin/Kodi remote-media（.strm 两种 body） — https://github.com/LeMetadatarr/media-archivist/blob/dev/docs/jellyfin.md
- STRM 生成方式、emby302 与网盘媒体工具横评 — https://zhuanlan.zhihu.com/p/1943793195491234280
- Strm 直链播放教程（动机/优势） — https://blog.csdn.net/qq_63499861/article/details/146411300
- Strm+Emby 应对网盘风控实践 — https://hiripple.com/zh/blog/2024-12-29-strmemby%E6%97%A0%E7%97%9B%E5%88%AE%E5%89%8A%EF%BC%8C%E5%BA%94%E5%AF%B9%E7%BD%91%E7%9B%98%E9%A3%8E%E6%8E%A7%E6%96%B0%E7%AD%96%E7%95%A5

**状态机 / 编排**
- npm registry: `xstate@5.33.3` — https://registry.npmjs.org/xstate/latest
- npm registry: `robot3@1.4.0` — https://registry.npmjs.org/robot3/latest
- npm: `@zag-js/core@1.46.0` — https://npmjs.com/package/@zag-js/core
- GitHub API: statelyai/xstate — https://api.github.com/repos/statelyai/xstate
- GitHub API: matthewp/robot — https://api.github.com/repos/matthewp/robot
- re-frame2 EP-0029（XState v6 alpha 解读，第三方） — https://github.com/day8/re-frame2/blob/main/docs/EP-0029-xstate-v6-machine-parity.md
- Temporal vs Inngest vs Trigger.dev vs BullMQ（二手对比） — https://devtoolreviews.com/reviews/temporal-vs-inngest-trigger-dev-vs-bullmq-2026
- Inngest 自部署官方文档 — https://inngest.com/docs/self-hosting
- Inngest `LICENSE.md`（SSPL-1.0 + Apache-2.0 future） — https://raw.githubusercontent.com/inngest/inngest/main/LICENSE.md
- `vardiya`（SQLite 队列） — https://npmjs.com/package/vardiya
- `izi-queue`（SQLite/PG/MySQL 队列） — https://github.com/iagocavalcante/izi-queue

**日志**
- pino 实践（级别/child/transport/redact） — https://axonbuild.com/blog/pino-logging
- Node.js Logging with Pino in 2026 — https://hirenodejs.com/blog/nodejs-pino-logging-production-2026
- pino transports 汇总（含 pino/file、pino-roll、pino-loki） — https://getpino.io/#/docs/transports
- Logdy — https://github.com/logdyhq/logdy-core

---

## 附：本次调研的明确「未查证」清单

1. **Lidarr**：未单独查证，仅按 Servarr 家族同构做推测。
2. **qBittorrent 上游 C++ 源码**：RSS 规则字段以 qui 文档与 qbittorrent-cli 为准，
   未读 `src/base/rss/rss_rule.cpp` 等。
3. **Seerr 状态枚举原文**：以搜索片段引用为准，未直读 `server/constants/media.ts` 全文。
4. **CloudDrive2 驱动接口**：未找到官方开源源码，不做任何接口结论。
5. **rclone `fs/features.go`**：未读，故未列举 Fs 级可选能力成员。
6. **XState v6 的官方状态**：仅见第三方 EP 文档，未在 statelyai/xstate 官方发布页核实。
7. **zag 仓库组织归属**（chakra-ui/zag vs saas-js/zag）：未核实两者关系。
8. **pino 生产关闭 pretty 的具体性能倍数**：二手实测，未复核。
9. **Inngest SDK 许可**：只核实了服务端 `LICENSE.md`。
