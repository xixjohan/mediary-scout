# MoviePilot（MP）架构调研报告
## ——订阅逻辑与「手动搜索→选择→入库→整理」链路

> 调研方式：官方 GitHub 仓库源码（v3 分支，commit 5cecf4c，2026-10-27）+ 官方文档（README、`docs/`、`docs/rules/`）+ 官方 Wiki（wiki.movie-pilot.org）+ 官方插件市场仓库（MoviePilot-Plugins）。
> 说明：`web_search` 未检索到独立的第三方深度分析文章（结果几乎全部指向官方文档/Wiki），因此交叉验证是在「官方文档 ↔ 源码 ↔ Wiki ↔ 官方插件仓库」之间完成的。
> 全文严格区分【事实】（有出处）与【推断】（我的判断，已标注）。

---

## 1. 整体架构

### 1.1 后端 / 前端 / 数据库【事实】

| 项 | 结论 | 出处 |
|---|---|---|
| 后端语言/框架 | Python 3.14+，FastAPI + Uvicorn，Pydantic v2，SQLAlchemy + Alembic，APScheduler 定时任务，asyncio | `docs/rules/02-tech-stack.md` |
| 数据库 | 默认 SQLite，可选 PostgreSQL（`DB_TYPE` 等环境变量，`app/modules/postgresql/`） | 同上；README「PostgreSQL 部署说明」 |
| 缓存 | 文件缓存 `FileCache`（默认）+ 可选 Redis 模块 | `docs/rules/02-tech-stack.md` |
| 前端 | 独立仓库 `MoviePilot-Frontend`（Vue 3 + TypeScript），主仓库只消费构建产物 `frontend-dist/`；本地 Node `service.js` 代理 `/api` 与 `/cookiecloud` | `docs/rules/01-project-overview.md`、`docs/rules/02-tech-stack.md` |
| 前后端交互 | REST API（`{success, message, data}` 信封）+ **SSE 流式**（搜索进度）+ Webhook（消息渠道回调）+ MCP 端点 `/api/v1/mcp` + OpenAI/Anthropic 兼容端点 | `app/api/endpoints/search.py`（`response_class=StreamingResponse`，`text/event-stream`）；README「Agent」节 |

README原文引用：

> 「前后端分离，后端基于 FastAPI，前端基于 Vue 3，部署和扩展边界更清晰。」—— https://github.com/jxxghp/MoviePilot

### 1.2 分层与调用方向【事实】

`docs/architecture-overview.md` 给出的分层（单向依赖的「模块化单体」）：

- **入口层**：`app/api`（REST/MCP）、`app/agent`（AI Agent 运行时）、`app/monitor`（目录监控）、`app/workflow`（工作流）、`app/scheduler`（定时任务）、`app/cli.py`、`app/plugins/*`（插件副本/覆盖层）
- **编排层**：`app/chain`（Chain 用例编排）、`app/application`（应用服务）
- **能力层**：`app/modules`（可插拔后端模块）、`app/db`（模型 + Oper）、`app/schemas`（传输模型/枚举）
- **契约层**：`app/domain`（纯业务语义）、`app/runtime`（进程级契约）
- **底层**：`app/foundation`（无状态原语）、`app/adapters`（技术 I/O 适配）
- **组合根/边界**：`app/startup`（Composition Root，构造并注入）、`app/sdk`（插件稳定导入面）、`app/runtime/compat`（旧导入路径兼容）

关键调用规则（`docs/rules/05-architecture.md`）：

> 「Chains interact with modules exclusively through `run_module` dispatch on method-name contracts; direct imports of module internals (classes, exceptions, constants) are forbidden, so every module stays pluggable and a chain never names a concrete module implementation.」

即：**Chain 通过方法名（字符串）向模块分发调用**，链路层不认识任何具体模块类。持久化路径：

```
入口（API / Agent / CLI / Scheduler / Workflow）
-> Chain 或 Application 用例
-> 命名 Port / Protocol
-> db/adapters 创建短生命周期 Session/UoW
-> db/oper 与 db/models
```

### 1.3 插件机制【事实】

来源：`MoviePilot-Plugins/docs/Plugin_Development.md`、`app/runtime/extensions/plugin/loader.py`、`docs/rules/01-project-overview.md`。

**是进程内 Python 类，不是独立服务**。原文引用：

> 「插件与主程序运行在同一个 Python 进程和依赖环境中。插件不是独立微服务，也没有独立虚拟环境，因此必须控制第三方依赖、后台线程、全局状态和导入副作用。」

一个插件涉及三个仓库的协作：

| 仓库 | 责任 |
|---|---|
| `MoviePilot` | 加载插件，提供事件、服务、API、数据、工作流和 Agent 运行时 |
| `MoviePilot-Frontend` | 渲染配置页、详情页、仪表板和 Vue 联邦远程组件 |
| `MoviePilot-Plugins` | 保存插件源码、市场元数据、图标、测试和发布配置 |

**发现与加载**：
- 插件源码从插件市场（`PLUGIN_MARKET`）或本地仓库路径（`PLUGIN_LOCAL_REPO_PATHS`）安装到 `app/plugins/`；
- 加载用 `importlib`，模块名固定为 `app.plugins.<插件ID>`（loader.py: `module_name = f"app.plugins.{plugin_dir.name}"`）；
- 插件主类必须继承 `app.sdk.plugin._PluginBase`，并实现生命周期钩子：`init_plugin(config)`、`get_state()`、`get_command()`、`get_api()`、`get_form()`、`get_page()`、`stop()`；
- 配置化前端：`get_form()` 返回声明式组件树（VForm/VSwitch/VTextField…）与默认值，宿主渲染成配置页；
- 支持「插件分身」（同一插件多实例，`instance_id`）、`PLUGIN_AUTO_RELOAD=true` 源码热重载；
- 卸载时把模块移出 `sys.modules`，并清理 Pydantic 泛型缓存/typing 下标缓存，防止旧模块驻留内存；
- 插件只依赖公开 SDK / Host SPI / `get_api()` 注册合同；旧 `app.core.*`、`app.helper.*` 导入路径由 `app/runtime/compat` 白名单精确映射到新归属（V2 插件兼容层）。

**隔离**：无进程/虚拟机隔离，仅靠「同一进程 + SDK 边界 + 兼容层 + 重载清理」。【推断】这是典型的「脚本插件」路线：换来零部署成本和完全共享宿主能力，代价是第三方依赖污染、崩溃即全崩、需要靠文档约定和门禁（架构基线快照、SCC 检查）来维持边界。

---

## 2. 订阅（Subscribe）模块

### 2.1 数据模型【事实】

ORM 模型位于 `app/db/models/subscribe.py`（`Subscribe` 表）、`subscribehistory.py`（`SubscribeHistory` 订阅历史表）、`subscribeactivity.py`（订阅活动记录）、`subscriptionsearch.py`（订阅搜索队列表）。运行期快照 DTO 在 `app/application/subscription/contract.py`（`SubscriptionSnapshot`）。

`Subscribe` 主要字段（源码注释直译）：

- 身份与媒体：`name`（标题）、`year`、`type`（电影/电视剧/音乐）、`media_source` + `media_id`（**统一媒体身份**，如 `douban+1295644` 与 `themoviedb+550` 是两个身份）、`season`、`episode_group`（剧集组）、`music_type`（recording/album）、`keyword`（搜索关键字）
- 季集规则：`total_episode`（总集数）、`start_episode`（开始集数）、`lack_episode`（缺失集数）、`note`（已下载集号列表）、`total_tracks`/`downloaded_tracks`（音乐专辑曲目进度）
- 过滤条件：`filter`（过滤规则串）、`include`/`exclude`（包含/排除）、`quality`/`resolution`/`effect`（质量/分辨率/特效）、音乐专用 `audio_quality`/`audio_format`/`min_bitrate`/`min_bit_depth`/`min_sample_rate`、`filter_groups`（选用的过滤规则组）、`custom_words`（自定义识别词）
- 行为与状态：`state`、`search_interval`（自定义搜索间隔，小时）、`sites`（订阅站点范围）、`downloader`、`save_path`、`search_imdbid`
- 洗版：`best_version`（是否洗版）、`best_version_full`（是否只洗全集整包）、`current_priority`（当前已接受版本优先级基线）、`episode_priority`（`{"1": 90, "2": 100}` 每集优先级状态）
- 其他：`poster`/`backdrop`/`vote`/`description`、`username`（订阅用户）、`date`、`last_update`、`last_search`、`activity_key`（贯穿活动订阅与历史订阅的业务键）、`identity_key`（完整订阅身份的唯一仲裁键，SHA256）

### 2.2 生命周期状态【事实】

`app/application/subscription/contract.py` 参数文档原文：

> 「`:param state: 订阅状态：N 为新建、R 为订阅中、P 为待定、S 为暂停`」

- `N` 新建（创建后由 `new_subscribe_search` 任务处理，搜索收尾时置 `R`，见 `app/chain/subscribe/search.py` 的 `_reset_new_subscription`：`{"state": "R"}`）
- `R` 订阅中（参与订阅刷新匹配、定时补漏搜索）
- `P` 待定（同样参与刷新匹配，`refresh.py` 中 `subscribe.state not in {"R", "P"}` 才跳过）
- `S` 暂停（阻止自动搜索与下载；手动/指定目标补搜可执行一次，但不会仅因搜索而恢复订阅）
- 完成后：写入 `SubscribeHistory`（携带同一 `activity_key`），订阅行本身可能被删除；音乐订阅按「已识别音轨稳定键累计」判定完成

【推断】MP 没有把「下载中/部分完成」做成订阅行的显式状态，而是用「缺集字段（`lack_episode`/`note`）+ 下载历史」推导进度；订阅行状态只表达「这个订阅是否还活着/是否参与自动匹配」。这点对我方「单用户追剧工具」很值得抄：状态少 = 状态机简单。

### 2.3 谁驱动状态流转：定时轮询为主【事实】

`app/scheduler/catalog.py` 中与订阅相关的调度任务（APScheduler 投影）：

| 任务 id | 名称 | 触发/间隔 |
|---|---|---|
| `new_subscribe_search` | 新增订阅搜索 | 短间隔轮询（处理 `state=N`） |
| `subscribe_search` | 订阅搜索补全 | `scheduled_interval` 默认 24 小时（Wiki：每隔 24 小时对订阅搜索一次补漏，且「时间间隔无法调整」） |
| `subscribe_search_queue` | 恢复订阅搜索队列 | 持久队列恢复（`JobRecoveryPolicy.DURABLE_QUEUE`） |
| `subscribe_refresh` | 订阅刷新 | 按设定周期（站点爬虫模式 20–40 分钟随机间隔，全天 32 次；或站点 RSS 模式，间隔须 >5 分钟） |
| `subscribe_tmdb` | 订阅元数据更新 | 定时更新订阅的媒体信息/总集数 |
| `subscribe_follow` | 关注的订阅分享 | 每小时 |
| `transfer` | 下载文件整理 | 每 5 分钟 |
| `mediaserver_sync` | 同步媒体服务器 | 按服务器配置间隔 |

Wiki《订阅》原文引用：

> 「添加订阅后，系统在3分钟内会进行一次全订阅站点的搜索，以下载目前已出的存量资源，对于未下载完整的则进入`订阅刷新`环节。」
> 「`自动`：使用内置的爬虫程序以一定范围的随机时间间隔获取各订阅站点种子列表页数据。每次访问间隔在`20-40`分钟左右，全天会对站点产生`32`次种子列表页访问请求……`站点RSS`：使用站点信息维护中的`站点RSS链接`，RSS访问时间间隔可自由设置（必须大于5分钟）。」
> 「为了解决这个情况MoviePilot增加了订阅搜索机制，每隔`24`小时可以对订阅进行一次搜索，以补充下载订阅可能漏掉的资源。」

### 2.4 订阅如何触发搜索【事实】

两条互补路径（源码 + Wiki 互相印证）：

1. **订阅刷新（增量匹配）**：`SubscribeChain.refresh()` → `TorrentsChain.refresh(sites=订阅站点)` 抓各站点种子列表页/RSS，写入按域名分文件的缓存（`_spider_file` / `_rss_file`，影视与音乐分开）→ `SubscribeChain.match(candidates, ...)` 对「本轮新出现的增量资源」逐条识别匹配。`torrents.py` 原文：「刷新站点最新资源并返回本轮可匹配的完整候选缓存。」Wiki：「每次刷新只处理站点新出现的增量资源数据。」
2. **订阅搜索（全量补漏）**：`SubscribeChain.search(state=...)` 复用同一个 `SearchChain`（与手动搜索同一实例），但通过 `SubscriptionSiteBudget` 应用订阅专属的关键词调度与 IMDb 查询去重；匹配到合格候选后进入下载。

命中后由 `app/chain/subscribe/policy.py` 调 `DownloadChain().batch_download(...)` 提交下载（缺集分批、整季、整包等阶段化批量下载）。

### 2.5 洗版 / 更新 / 缺失集补全的表达【事实】

- **洗版**：`best_version=1` + `best_version_full`。Wiki《订阅》：「订阅开启洗版后，匹配到资源并成功下载后订阅**不会自动删除**，匹配到比之前下载的资源更高优先级的资源会会继续下载，直到下载到了`洗版优先级`中优先级最高的资源为止。对于剧集，只有完结状态的剧集才支持洗版。**洗版需要与整理覆盖模式设置配合**。」
  源码侧完成判据（`app/application/subscription/priority.py`）：优先级 `100` = 洗版目标优先级（`current_priority == 100` 或所有目标集 `episode_priority[str(ep)] == 100` 即完成）。
- **缺失集补全**：`total_episode`/`start_episode`/`lack_episode` + `note`（已下载集号）；`compute_lack_episode()` 由「媒体事实总集数 − 已下载集」推导；`episode_group` 支持同一剧的不同集数编排（如 TMDB 的剧集组）。
- **元数据更新**：`subscribe_tmdb` 任务刷新总集数等事实；`manual_total_episode` 允许用户手工指定总集数避免被自动刷新覆盖。

---

## 3. 搜索与选择

### 3.1 搜索分层【事实】（Wiki《搜索》+ 源码）

- **媒体信息搜索**：`ctrl+K` 聚合搜索窗口，可多数据源（TMDB/豆瓣/Bangumi/AniList/IMDb/TVDB/MusicBrainz/TheAudioDB…，插件可注册新来源），按设置的先后顺序排序。
- **资源搜索**分两种：
  - **精确搜索**：先识别媒体信息，再按该媒体身份搜站点，结果经过滤规则/优先级处理。Wiki：「手动下载时需要识别资源才能进行下载。」
  - **模糊搜索**：聚合搜索窗口直接搜站点资源，Wiki：「直接展示站点搜索返回的数据，**不经过滤规则、优先级规则等处理**。」
- **流式搜索**：V3 资源搜索页走 SSE（`GET /api/v1/search/media/{media_id}/stream`「渐进式精确搜索资源」），页面持续展示进度/实时结果，不支持流式时自动回退普通请求。
- **AI 智能推荐**：在已有搜索结果上做二次筛选排序，不替代原始站点搜索。

### 3.2 排序 / 打分 / 去重【事实】

- **排序**：`app/application/torrent/download.py` 的 `TorrentHelper.sort_torrents()`：以「标题 + 各优先级规则字段 + 季集数」拼成排序字符串，倒序排列。默认优先级规则 `["torrent", "upload", "seeder"]`（可含 `site`），分别对应：资源优先级（`pri_order`，含站点促销 free/2x 等）、站点上传量、做种数；另有 `site_order`（站点优先级，数值越小越优先，来自站点卡片拖动排序）与「无集数的排最前、集数多的排前」。
- **过滤**：`app/modules/filter/__init__.py` 的 `FilterModule.filter_torrents(rule_groups, ...)`：规则项（正则/大小范围/发布时间/做种数…）+ 规则组（可多组组合），支持 Rust 加速实现；全局「默认过滤规则」+ 订阅/搜索各自选用的规则组（V3 重新设计的过滤规则体系）。
- **去重**：`app/chain/search/result.py` 的 `_remove_duplicate()`「按站点、标题和描述去重，并保留既有顺序语义」；`sort_group_torrents()`「排序后重新加入数组，按真实名称控重，即只取每个名称的第一个」。

### 3.3 人工介入路径（重点）【事实】

**MP 搜索不是纯自动，存在完整的人工选种链路**：

1. **Web 手动下载**：`POST /api/v1/download`（`app/api/endpoints/download.py`）——入参 `media_in`（媒体信息）+ `torrent_in`（种子信息）+ 可选 `downloader`/`save_path`，内部构造 `Context(meta_info, media_info, torrent_info)` 后调 `DownloadChain().download_single(context=..., source="Manual")`。源码注释：「手动下载始终使用选择的下载器」。
   Wiki《下载》：「手动下载时需要识别资源才能进行下载。下载目录无法在手动下载时指定，而是由系统识别资源后自动判定。」
2. **远程（消息渠道）人工选择**：`app/chain/interaction.py` 中 `DownloadChain().download_single(...)`（用户回复编号/点按钮）；Wiki：「V1版本通过维护变量`AUTO_DOWNLOAD_USER`来设定远程搜索时是自动择优下载还是发送资源列表让用户选择，V2版本可以直接在界面中调整设置。」
3. **事件挂钩子**：`ChainEventType.ResourceSelection`（资源选择）、`ResourceDownload`（资源下载）允许插件介入选择/下载环节。
4. **AI 推荐作为人工辅助**：先普通搜索 → 筛选 → 「AI智能推荐」再排序。

【推断】对我方最有价值的是这个 API 形状：**「媒体信息 + 资源条目」二元组 → 一个 `download_single(source="Manual")`」**。它把「手动选择」和「订阅自动选择」收敛到同一个下载入口，只差 `source` 与上下文来源——我方可以原样照搬这个建模。

---

## 4. 入库与整理（Transfer + 整理）

### 4.1 磁力/种子如何变成文件【事实】

MP 的「入库」= **下载器下载 → 本地下载目录 → 整理进媒体库/网盘**：

1. `DownloadChain.download_torrent()`：`magnet:` 前缀直接返回磁力链接本身；否则带站点 Cookie/UA 下载 `.torrent` 文件（含换票种子的本地缓存与签名 URL 重试一次）。
2. 交给下载器模块（qBittorrent / Transmission / rTorrent，统一基类 `_DownloaderBase`）下载到「下载目录」，并通过 `path_mapping` 做容器/宿主路径映射。
3. 下载完成后由调度任务 `transfer`（每 5 分钟）驱动 `TransferChain.process()`：`list_torrents(status=TorrentStatus.TRANSFER)` 取已完成任务，按 hash 去重（`_unique_pending_torrents`），进入 durable 整理队列。
4. 整理目标存储由 `StorageChain` 统一编排（见 4.2）。

**关于「分享链接入库」**【事实 + 未查证】：MP 核心代码中**没有**网盘分享链接解析/转存能力（`grep` 全仓 `分享链接/share_url` 只命中 `MoviePilotServerHelper.recognize_share_url`，那是服务端「媒体识别」API，与网盘转存无关）。MP 的网盘是「整理目标」而不是「下载源」。第三方插件（如 `odomu/MoviePilot-Plugins` 的「网盘订阅助手 CloudSubscribe」，自称「多网盘全自动资源调度与媒体库整理插件，深度打通全网主流搜索源与各类云盘存储生态」）才做分享链接调度——**其实现细节未查证**。

### 4.2 多网盘抽象：适配器 + 能力声明【事实】

- 枚举 `StorageSchema`（`app/schemas/types.py`）：`Local`、`Alipan`（阿里云盘）、`U115`（115）、`Rclone`、`Alist`、`AlistGo`、`SMB`。**没有**夸克/天翼/WebDAV 的内置枚举值。
- 实现目录 `app/modules/filemanager/storages/`：`local.py`、`alipan.py`、`u115.py`、`alist.py`、`alistgo.py`、`rclone.py`、`smb.py`，全部继承抽象基类 `StorageBase`（`storages/__init__.py`）。
- `StorageBase` 抽象方法（接口形状）：`check / list / create_folder / get_folder / get_item / delete / rename / download / upload / detail / copy / move / link / softlink / reflink / usage`；另有 `support_transtype()` / `is_support_transtype()` 声明「本存储支持哪些整理方式」。
- **整理方式按存储能力分化**【事实】（各存储类上的 `transtype` 字典）：
  - `LocalStorage`：`copy 复制 / move 移动 / link 硬链接 / softlink 软链接 / reflink 引用链接`
  - `U115Storage` / `RcloneStorage` / `AlipanStorage` / `AlistStorage`：仅 `move 移动 / copy 复制`（云盘侧即上传/下载）
- **统一管理合同**【事实】（`docs/rules/05-architecture.md`）：「Channels and storages that need login management or temporary-parameter initialization follow one generic contract instead of per-target APIs: modules implement `storage_manage(storage, action, **params)` … All results use the unified `{"success": bool, "message": ..., "data": ...}` shape.」`StorageChain.manage_storage()` 透明转发，不包含任何存储特定逻辑。
- `StorageChain`（`app/chain/storage.py`）其余能力：`list_files / any_files / create_folder / get_folder / download_file / upload_file / link_file / delete_file / rename_file / exists / get_item`，全部 `run_module(...)` 分发。

### 4.3 「转移」是策略模式吗？【事实+推断】

【事实】V3 已把 V2 的 `app/modules/transfer` 插件式转移重构为 `app/chain/transfer/` 包（queue/plan/execution/settlement/history/filter/format/music/records/request/retry/scrape/workflow 等 20 个子模块），整理执行通过 `StorageChain` 调存储适配器；同时保留「external legacy transfer provider」兼容合同（`_TransferChain__execute_legacy_transfer_providers`）。
【推断】这是**策略模式的两种实现叠加**：(a) 「整理方式」是策略（copy/move/link/softlink/reflink，按存储能力选择）；(b) 存储本身是策略族（每存储一个适配器类）；(c) legacy provider 序列是责任链式的「依次尝试」。对我方而言，理解到 (a)+(b) 就够，不必抄 provider 序列。

### 4.4 文件整理（重命名/软硬链/通知/模板）【事实】

- **命名模板**：Wiki《进阶》——「MoviePilot文件重命名格式定义基于 `jinja2` 语法」，分别有电影/电视剧（`TV_RENAME_FORMAT` 额外支持 `season/season_fmt/episode/season_episode/episode_title/episode_date`）与音乐（`MUSIC_RENAME_FORMAT`，优先读音频标签）三套格式；通用变量含 `title/original_title/year/type/category/vote_average/resourceType/effect/edition/videoFormat/resource_term/releaseGroup/videoCodec/videoBit/audioCodec/fps/webSource/tmdbid/imdbid/doubanid/fileExt/customization` 等。示例：
  ```jinja2
  {{title}}{% if year %} ({{year}}){% endif %}/{{title}}{% if year %} ({{year}}){% endif %}{% if videoCodec %} - {{videoCodec}}{% endif %}{% if videoBit %} {{videoBit}}{% endif %}{{fileExt}}
  ```
- **软链/硬链语义**：Wiki《文件整理》——「软链接：类似于快捷方式，原文件删除后软链接即会失效……在docker环境下，映射前后的目录路径需要一致」「移动：移动文件存储位置，会影响原文件做种」；音乐标签/封面写入时会先复制再替换入口，保护做种源文件。
- **STRM**：**V3 核心整理方式不含 STRM**【事实】——全仓 `strm` 仅出现在 `app/runtime/config.py`（媒体扩展名清单，含 `.strm`）与 `app/schemas/event.py`（注释示例）；第三方插件/需求讨论中才出现 STRM 软链目标删除等场景（MoviePilot-Plugins issue #435）。
- **目录结构/分类**：二级分类由「自动分类策略」驱动，V3 把分类策略升级为「多媒体、多来源、版本化（revision）+ 可视化编辑器 + 发布前校验 + 影响分析 + 回滚」；目录/订阅/历史同时记录 `category_id` 与路径快照（改名不破坏既有归属）。
- **Emby/Jellyfin 通知**：宿主侧媒体服务器模块提供**查询**（`media_exists`、`mediaserver_*`）与**定时同步**（`mediaserver_sync`）；**入库后主动刷新媒体库由官方插件完成**【事实】：`plugins/mediaserverrefresh/__init__.py`（插件名「媒体库服务器刷新」）中
  ```python
  @eventmanager.register(EventType.TransferComplete)
  ```
  并调用 Emby/Jellyfin/Plex 客户端的 `refresh_library_by_items(items)`。宿主通过 Outbox 可靠投递 `transfer.complete` 事件（`app/application/outbox.py`、`app/startup/composition/outbox.py`）。
- **手动整理**：`POST /api/v1/transfer/manual/target-path`（匹配目的路径，可预览）→ `POST /api/v1/transfer/manual`（执行）；`GET /api/v1/transfer/queue`（整理队列）；历史记录支持重新整理。
- **durable 执行与人工复核**【事实】：`TransferExecutionState` = `not_started / running / retry_wait / settling / failed / manual_review`；每个外部步骤持久化 checkpoint；提供 `GET/POST /api/v1/transfer/tasks/manual-reviews` 等人工复核 API（「人工判定整理步骤的外部执行结果」「放弃人工复核整理任务但保留文件」）。

---

## 5. 多站点 / 多网盘抽象

### 5.1 站点层【事实】

- 站点配置存 DB（`app/db/models/site.py`），字段（Wiki《站点》）：站点地址、**优先级**（数值越小越优先，可拖动调整）、RSS 地址、超时时间、Cookie、Authorization、API Key、User-Agent、**站点流控**（单位周期访问次数/间隔）、代理、浏览器仿真。
- **站点适配 = 解析器族**【事实】：`app/modules/indexer/parser/__init__.py` 定义 `SiteSchema` 枚举与 `SiteParserBase`（DiscuzX、Gazelle、NexusPhp、NexusProject、NexusRabbit、NexusHhanclub、NexusAudiences、SmallHorse、Unit3d、TorrentLeech、FileList、TNode、MTorrent(M-Team API)、Yema、HDDolby、Zhixing、Bitpt、RousiPro、SunnyPT…），`IndexerModule.init_module()` 用 `ModuleHelper.load('app.modules.indexer.parser', filter_func=...schema...)` 动态加载全部解析器；另有 `spider/`（haidan、mtorrent、rousi、tnode、yema、sunnypt…）处理搜索页。
- 站点资源索引包：`resources.v3` + `user.sites.v3.bin`（独立 `MoviePilot-Resources` 仓库维护，V2/V3 互不覆盖）；CookieCloud 批量同步 Cookie；站点连接状态（绿/黄/红）与统计。
- 【推断】这是「**框架型适配器 + 数据驱动配置**」：不为每个 PT 站写一个类，而是按站点程序框架（NexusPHP/Unit3D/Gazelle…）写解析器，再靠资源索引包把上百个站点映射到框架 + 分类参数。我方若只有少量固定来源，直接用「每来源一个适配器类 + 声明式配置」更简单；若也要支持大量 PT 站，才值得考虑这层。

### 5.2 网盘层

见 4.2。补充【推断】：夸克、天翼、WebDAV 在 MP 中**没有一等公民适配器**，可行路径是 (a) Alist/AlistGo/Rclone 聚合存储适配（这些后端本身支持夸克/天翼/WebDAV 驱动），(b) 第三方插件。**该可用性未实测验证**。

---

## 6. 可明确识别的设计模式

### 6.1 官方文档明确列出（`docs/rules/04-design-patterns.md`）【事实】

| 模式 | 用在哪里 |
|---|---|
| **Module（可插拔后端）** | `_ModuleBase` + `_DownloaderBase`/`_MediaServerBase`/`_NotificationBase`；下载器、媒体服务器、消息渠道、存储、元数据源、过滤器、索引器 |
| **Chain 编排** | `ChainBase` + `run_module()` 按方法名分发；API/CLI/Agent/Scheduler/Webhook 共用用例 |
| **Event / Observer** | `EventManager`（单例 `eventmanager`）+ `EventType`/`ChainEventType`；如 `@eventmanager.register(EventType.TransferComplete)` |
| **Repository（Oper）** | `app/db/models/X.py` ↔ `app/db/oper/X.py` 一一对应；宿主入口只依赖 Application Protocol，`db/adapters` 建 Session/UoW |
| **Config Reload** | `ConfigReloadMixin` + `CONFIG_WATCH`，配置变更后停旧资源并重新初始化 |
| **Singleton** | `EventManager`、`ModuleManager`、`PluginManager` |
| **SystemConfig / UserConfig** | `SystemConfigKey` 枚举 + `get_configured_system_config()`；用户级配置分离 |

### 6.2 源码中还可识别【事实+推断】

| 模式 | 位置 | 说明 |
|---|---|---|
| **Adapter（适配器）** | `StorageBase` + 7 个存储实现；`SiteParserBase` + 20 个 `SiteSchema` 解析器；`_DownloaderBase`/`_MediaServerBase` | 统一接口封装异构外部系统 |
| **Strategy（策略）** | `transtype` 整理方式（copy/move/link/softlink/reflink）；`TorrentsPriority` 排序规则；legacy transfer provider 序列 | 行为可插拔、按能力选择 |
| **Facade（门面）** | 各 chain 包根只暴露 `<Domain>Chain`；`app/sdk` 作为插件稳定导入面；`facade.py` 保持公共身份 | 隐藏 owner 拆分，稳定 ABI |
| **Mixin + Owner 单一职责拆分** | `app/chain/<domain>/` 包内 `contract.py`（Protocol 声明宿主能力）+ 多个单字职责 owner（create/search/match/refresh/completion…） | V3 大型重构的拆分手法 |
| **Composition Root / DI** | `app/startup` 构造并注入 `ChainRuntimeContext`、db adapters、Adaptor | 组合根统一装配 |
| **Ports & Adapters（六边形）** | Application 拥有 Port/Protocol，`db/adapters` 提供实现；静态 import 方向与运行时调用方向相反 | 架构文档明确表述 |
| **Outbox（可靠副作用）** | `app/application/outbox.py` + dispatcher（topic/claim/lease/有限重试/dead-letter；成功记录保留 30 天、dead letter 90 天） | 业务行与 durable intent 同事务提交 |
| **State Machine（状态机）** | 订阅 `N/R/P/S`；`TransferExecutionState` + `TransferStepState`（prepared/…） | 持久化状态 + 人工复核态 |
| **Template Method（模板方法）** | `_ModuleBase.init_module/init_setting/get_type/get_subtype/get_priority/stop/test`；`StorageBase` 抽象方法 | 子类填空 |
| **责任链（推断）** | `run_module` 分发「返回 None 表示本模块未处理，由调度方继续尝试后续模块」（`_ModuleBase` 文档字符串） | 模块串行尝试 |

---

## 7. 对我方项目（单用户自部署、Next.js + SQLite + TypeScript）的借鉴与排除

### 7.1 值得抄【推断】（按性价比排序）

1. **「媒体身份 = 来源 + 来源内 ID」**（`media_source + media_id`，如 `douban+1295644`）。避免裸数字 ID 跨源混淆，同名/同年误匹配大幅减少。成本极低，收益极大。
2. **订阅的数据形状**：订阅 = 「媒体身份 + 季集范围（total/start/lack/note）+ 过滤条件（include/exclude/quality/resolution/effect）+ 站点范围 + 行为开关（洗版/整包/自定义间隔）」的快照；完成态移入「历史表」并用 `activity_key` 关联。状态只用 `N/R/P/S` 四个值。
3. **缺集计算驱动追更**：`lack_episode = 总集数 − 已下载集(note)`；「追更」本质上是一个纯函数问题，不需要复杂工作流。
4. **洗版的最简表达**：`best_version` 开关 + `current_priority` 基线 + 「优先级 == 目标最大值即完成」；整包洗版用 `best_version_full`。比「版本比较引擎」简单一个数量级。
5. **刷新 vs 搜索的双轨**：「增量刷新（站点列表/RSS → 缓存 → 匹配）」负责日常追更，「全量搜索（24h）」负责补漏；两者共用同一个搜索实现。我方可以做成「定时增量轮询 + 手动/定期全量补搜」。
6. **过滤规则组 + 可配置排序键**：规则项（正则/大小/做种数/发布期）+ 规则组（可多组组合）；排序键可配置（默认 资源优先级/站点上传/做种数）。比硬编码过滤条件可维护得多。
7. **存储抽象（重点）**：统一接口（list/get/create/delete/rename/download/upload/copy/move/link/softlink）+ **能力声明**（`support_transtype`：本地支持硬/软链接，网盘只支持上传/复制）+ 一个泛化管理合同（`storage_manage(storage, action, params)` → 统一 `{success,message,data}`）。这正好覆盖我方「多网盘增删查改 + 批量操作」的诉求，且前端可以完全数据驱动。
8. **手动路径与自动路径收敛到同一入口**：`download_single(context, source="Manual"|"Subscribe")`；「手动搜索 → 人工选种」就是「搜索结果中选一条 → 带媒体信息提交」。API 形状：`POST /download { media_in, torrent_in, downloader?, save_path? }`。
9. **手动整理的「先算目标路径再执行」**：`/transfer/manual/target-path` 预览目的路径 → `/transfer/manual` 执行。对「整理」这种破坏性操作，预览-确认两步非常值得抄。
10. **Outbox / 持久化步骤 + 人工复核**：入库涉及外部副作用（网盘 API），MP 的「意图先落库 → 调度重试 → 失败冷却 → 无法推断时转人工复核」是对单用户自部署同样适用的稳健设计（进程重启不丢任务）。
11. **事件总线**：`transfer.complete` / `download.added` 等事件解耦「媒体服务器刷新、消息通知、订阅完成判定」。TS 里用一个 typed EventEmitter 即可，成本低。
12. **搜索流式化（SSE）**：多站点搜索耗时长，SSE 进度 + 实时结果预览显著改善体验；不支持流式时回退普通请求。

### 7.2 不该抄 / 需要裁剪【推断】

| MP 的设计 | 为什么不适用 |
|---|---|
| 进程内 `importlib` 插件机制 + `app/runtime/compat` 兼容层 + SDK 门面 | TS 项目用「适配器注册表 + 声明式配置 + 少量受控扩展点」即可；兼容层是 10k commit 项目的历史债务治理，不是起点 |
| V3 的 chain 包 + owner 类 + `_contracts.py` Protocol + startup 组合根 + 架构机器门禁（SCC 快照、Adapter 直连检查） | 治理成本极高，适合大型协作项目；单用户项目会过度工程。借鉴其「分层意图」即可（api → service(chain) → provider(module) → db） |
| 多用户/权限/审批（`auth_level`、用户订阅请求与审批）、订阅分享/follow（社交功能） | 单用户自部署完全不需要 |
| 站点爬虫族 + `resources.v3` 索引包 + 浏览器仿真 + Cloudflare 绕过 + CookieCloud + OCR 登录 | 深度绑定国内 PT 生态；我方若不抓 PT 站点则整层不需要；若需要，优先对接 Jackett/Prowlarr 类现成索引器，而不是自建 20 个解析器 |
| 下载器依赖（qBittorrent/Transmission/rTorrent）+ 路径映射 + 5 分钟轮询下载器 | 我方链路是「网盘入库（分享链接/磁力）」而非「本地下载器做种」；应改为网盘 SDK 直连 + 任务状态机（可借鉴其 durable 队列思想） |
| Rust 加速扩展（`moviepilot-rust`）、AI Agent/MCP/工作流引擎、音乐全链路、刮削 | 与「资源搜索/网盘入库/网盘管理」核心无关，属于后期可选能力 |
| 「媒体库整理」的重命名/刮削/二级分类策略全链条 | 我方是「媒体追踪/追剧」，若不做本地媒体库刮削，只需保留「目标目录 + 命名模板」的最小子集 |

### 7.3 一句话架构建议【推断】

我方可以按「**MP 的领域建模 + 20% 的 MP 工程结构**」落地：
- 领域层照抄：媒体身份（source+id）、订阅快照 + N/R/P/S、缺集计算、洗版优先级基线、过滤规则组、可配置排序、存储适配器 + 能力声明、手动/自动同一下载入口、target-path 预览后执行、Outbox 式持久化任务。
- 结构层从简：`app/api`(Next.js route handlers) → `service`(用例编排) → `provider`(站点/网盘适配器，注册表 + 能力声明) → `repository`(SQLite/Drizzle)；一个轻量 typed 事件总线；任务队列表（意图 + 重试 + 人工复核）用 SQLite 即可，不必引 Redis。

---

## 附：关键出处清单

**官方仓库（源码/文档）**
- README：https://github.com/jxxghp/MoviePilot
- 架构总览：https://github.com/jxxghp/MoviePilot/blob/v3/docs/architecture-overview.md
- V2→V3 变化：https://github.com/jxxghp/MoviePilot/blob/v3/docs/v2-to-v3-overview.md
- 设计模式规则：https://github.com/jxxghp/MoviePilot/blob/v3/docs/rules/04-design-patterns.md
- 架构规则：https://github.com/jxxghp/MoviePilot/blob/v3/docs/rules/05-architecture.md
- 技术栈：https://github.com/jxxghp/MoviePilot/blob/v3/docs/rules/02-tech-stack.md
- 项目概览：https://github.com/jxxghp/MoviePilot/blob/v3/docs/rules/01-project-overview.md
- 订阅模型：https://github.com/jxxghp/MoviePilot/blob/v3/app/db/models/subscribe.py
- 订阅历史模型：https://github.com/jxxghp/MoviePilot/blob/v3/app/db/models/subscribehistory.py
- 订阅快照契约（状态语义）：https://github.com/jxxghp/MoviePilot/blob/v3/app/application/subscription/contract.py
- 订阅刷新：https://github.com/jxxghp/MoviePilot/blob/v3/app/chain/subscribe/refresh.py
- 订阅搜索：https://github.com/jxxghp/MoviePilot/blob/v3/app/chain/subscribe/search.py
- 洗版优先级：https://github.com/jxxghp/MoviePilot/blob/v3/app/application/subscription/priority.py
- 调度任务目录：https://github.com/jxxghp/MoviePilot/blob/v3/app/scheduler/catalog.py
- 存储编排：https://github.com/jxxghp/MoviePilot/blob/v3/app/chain/storage.py
- 存储基类：https://github.com/jxxghp/MoviePilot/blob/v3/app/modules/filemanager/storages/__init__.py
- 本地存储（transtype）：https://github.com/jxxghp/MoviePilot/blob/v3/app/modules/filemanager/storages/local.py
- 115 存储：https://github.com/jxxghp/MoviePilot/blob/v3/app/modules/filemanager/storages/u115.py
- 公共枚举（StorageSchema/EventType/ModuleType）：https://github.com/jxxghp/MoviePilot/blob/v3/app/schemas/types.py
- 搜索结果处理（去重/过滤）：https://github.com/jxxghp/MoviePilot/blob/v3/app/chain/search/result.py
- 手动下载 API：https://github.com/jxxghp/MoviePilot/blob/v3/app/api/endpoints/download.py
- 搜索 API（SSE）：https://github.com/jxxghp/MoviePilot/blob/v3/app/api/endpoints/search.py
- 整理 API：https://github.com/jxxghp/MoviePilot/blob/v3/app/api/endpoints/transfer.py
- 整理执行状态机：https://github.com/jxxghp/MoviePilot/blob/v3/app/application/transfer/execution.py
- 整理队列/process：https://github.com/jxxghp/MoviePilot/blob/v3/app/chain/transfer/queue.py
- 种子排序：https://github.com/jxxghp/MoviePilot/blob/v3/app/application/torrent/download.py
- 插件加载器：https://github.com/jxxghp/MoviePilot/blob/v3/app/runtime/extensions/plugin/loader.py
- 站点解析器族：https://github.com/jxxghp/MoviePilot/blob/v3/app/modules/indexer/parser/__init__.py

**官方 Wiki**
- 订阅：https://wiki.movie-pilot.org/subscribe
- 搜索：https://wiki.movie-pilot.org/search
- 下载：https://wiki.movie-pilot.org/download
- 文件整理：https://wiki.movie-pilot.org/reorganize
- 站点：https://wiki.movie-pilot.org/site
- 进阶（重命名模板/分类策略）：https://wiki.movie-pilot.org/advanced
- 插件开发：https://wiki.movie-pilot.org/plugindev

**官方插件仓库**
- 插件开发指南（V3）：https://github.com/jxxghp/MoviePilot-Plugins/blob/main/docs/Plugin_Development.md
- 媒体库服务器刷新插件（TransferComplete 观察者实例）：https://github.com/jxxghp/MoviePilot-Plugins/blob/main/plugins/mediaserverrefresh/__init__.py

**未查证 / 存疑**
- 第三方深度分析文章（web_search 未返回，结果均为官方文档）
- MP 核心是否支持网盘分享链接转存（代码未见；第三方 CloudSubscribe 插件自称支持，未读源码验证）
- 夸克/天翼/WebDAV 网盘在 MP 的实际可用路径（推断经 Alist/Rclone，未实测）
- 前端仓库 `MoviePilot-Frontend` 内部实现（未读）
