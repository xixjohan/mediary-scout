# 剩余优化盘点 与 影片匹配字幕显示 · 可行性与方案调研

> 调研日期：2026-11-13
> 关联文档：`2026-11-13-player-telemetry-and-startup-latency-research.md`（P1/P2 已实施）
> 参考实现：`E:\WorkProject\Node\_BrowserExtend\【油猴脚本】\视频播放器优化v2`（下称「参考脚本」）
> 主机地址统一以 `<DEV_HOST>` 占位；真实凭据仅存于 `env/.envdev`。

---

## 1. 结论摘要

**问题一：剩余优化还有哪些？能否执行？**

上一轮方案共 9 项待办，**6 项可立即执行**（其中 4 项为低风险小改），**2 项需要设计评审**（Range 共享池、首部预取），**1 项已被否决**（移除 `Connection: close`）。另有 2 项受外部凭据阻塞（TTFB 实测、`pick_code` 存量回填）。

**问题二：能否支持影片匹配字幕显示？**

**能，而且基础设施已具备大半**——`assrt.net` 字幕客户端（`subtitle-provider.ts`）已存在且支持 `search` + `detail`（返回可下载文件直链），ArtPlayer 原生支持 `vtt/srt/ass` 三种格式并内置 `srtToVtt`/`assToVtt` 与 `subtitleOffset` 偏移控制。真正的缺口不是"能不能显示"，而是**匹配质量、语言判定、编码处理、以及内嵌字幕轨道**。

**同时发现 4 个现存缺陷**（非新功能，属于"本该能用却没用对"）：

1. SRT 字幕被声明为 `vtt` 类型 → ArtPlayer 跳过 `srtToVtt` 转换，时间轴带逗号且无 `WEBVTT` 头，**大概率整条不显示**；
2. 外挂字幕语言恒为 `"und"` → 无法按语言自动选轨，多字幕时只能盲选第一条；
3. 只加载**第一条**字幕，无切换入口，即使同目录有中英双语两条也只能看到一条；
4. `subtitleOffset` 未开启，字幕整体偏移时用户无法微调。

这四条修复成本极低（合计约半天），收益立竿见影，建议先于"在线匹配"落地。

---

## 2. 第一部分：未执行的优化盘点

### 2.1 全量对照表

| 编号 | 项 | 状态 | 能否现在执行 | 成本 | 风险 | 前置条件 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| S2 | 详情页预热直链（`HEAD` 预解析） | 未执行 | **能** | 0.5 天 | 低（须复用 115 漏桶） | 无 |
| S3 | 移除 `Connection: close` | **已否决** | 否 | — | 高（stale socket reset） | — |
| S4 | 分段加载文案 | 已执行 | — | — | — | — |
| S5 | 直链缓存键正确性核查 | 已核查 | — | — | — | 结论见 2.4 |
| M1 | 服务端 Range 共享池 | 未执行 | 能（需设计评审） | 3–5 天 | 中（内存/并发） | 无 |
| M2 | 首部优先预取（`moov` 在尾部） | 未执行 | 能（需设计评审） | 2–3 天 | 中 | 无 |
| M3 | 代理 keep-alive / 背压 | **基本已具备** | 无需改 | — | — | 见 2.5 |
| M4 | 预热策略中心 | 未执行 | 能（依赖 S2） | 1 天 | 低 | S2 |
| M5 | 按错误类型快速失败 + 上游超时 | 未执行 | **能** | 0.5 天 | 低 | 无 |
| D1 | `pick_code` 存量回填 | 未执行 | 能（需重扫） | 0.5 天 + 扫描耗时 | 低 | 115 凭据有效 |
| D2 | TTFB / 首帧实测校准 | 阻塞 | 否 | — | — | 115 重新授权 |

### 2.2 建议立即执行的 4 项（低风险、可独立回滚）

**① S2 预热直链**

在详情面板打开时（用户还在看简介、选集），对当前选中单集发一次 `HEAD /api/strm/play/...`，把 `getFileInfo → downurl` 的 1.2–2.4 s 成本挪到"浏览阶段"。

- 必须复用 115 品牌漏桶（`withBrandPacing`），**不能**绕过限速；
- 并发上限 1，失败静默，不做重试；
- 命中 `strm_link_cache` 时是纯内存/DB 读，几乎零成本。

**② M5 上游超时与快速失败**

现状：`/api/strm/play` 的 proxy 分支只挂了 `signal: request.signal`，**没有服务端超时**。上游 CDN 卡住时请求会一直挂着，直到浏览器主动断开。

建议：

```ts
signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
```

并按错误类型分级降级（鉴权失效 1.5 s、限流 3 s、未知 8 s），替代当前"一律等 8 s"。

**③ 字幕四缺陷修复**（详见 3.2）

- SRT 类型判定改为按 `format` 透传（`srt` → `srt`，让 ArtPlayer 走 `srtToVtt`）；
- 开启 `subtitleOffset: true`；
- 多字幕时提供切换入口（`art.subtitle.switch`）；
- 从文件名推断语言（`zh/cht/eng/ja`…），替代恒为 `und`。

**④ `pick_code` 存量回填**

映射修复只对新扫描生效。存量条目需一次重扫，或写一个只读目录、只 `UPDATE pick_code` 的轻量回填脚本（不重建媒体项、不动标题/季集结构）。

### 2.3 需要设计评审的 2 项

| 项 | 为什么要评审 | 建议边界 |
| :--- | :--- | :--- |
| M1 Range 共享池 | 引入服务端内存缓存与并发协调，涉及淘汰策略、内存上限、多用户隔离 | 单实例上限 64 MB、LRU、按 `storageId:fileId` 隔离、只缓存前 N MB |
| M2 首部优先预取 | 需要判断容器类型与 `moov` 位置，误判会导致额外 Range 反而变慢 | 仅对 `.mp4/.m4v` 且 `moov` 不在头部时补尾部 Range；MKV 不预取 |

### 2.4 S5 核查结论（缓存键）

`buildStrmLinkCacheKey({ storageId, fileId, deliveryMode, userAgent })`：

- proxy 模式忽略 UA（服务端统一 UA），redirect 模式按 UA 分组——**设计正确**；
- 存在 `storageId:fileId` 的降级回退键，命中后不会区分投送模式。这是**有意的兼容**，但意味着"先用 proxy 缓存、再切 redirect"可能拿到 proxy 时期的直链。由于直链本身与投送模式无关（模式只决定谁去拉流），**不构成缺陷**。

### 2.5 M3 核查结论（连接复用与背压）

- 上游：Node 全局 `fetch`（undici）默认连接池复用，未显式 `Connection: close`（仅 115 的 API 客户端有）；
- 下游：`new Response(upstreamResp.body)` 是 Web Streams 直通，背压由运行时处理，未额外缓冲放大内存。

结论：**M3 无需额外改动**，原方案中的这一项可以关闭。

---

## 3. 第二部分：影片匹配字幕显示

### 3.1 现状测绘

| 能力 | 现状 | 位置 |
| :--- | :--- | :--- |
| 同目录外挂字幕发现 | ✅ 扫描时收集，按"视频名去扩展名前缀"匹配 | `library-scanner.ts:163-176, 235-240` |
| 字幕 URL 生成 | ✅ 走同一 proxy 通道 `/api/strm/play/...&delivery=proxy` | `api/library/play/[episodeId]/route.ts:77-85` |
| 播放器加载 | ⚠️ 只加载第一条，类型按 `ass ? ass : vtt` 硬映射 | `mediary-player-core.tsx:162-175` |
| 多轨切换 | ❌ 无 UI | — |
| 语言判定 | ❌ 恒为 `"und"` | `library-scanner.ts:171` |
| 编码处理 | ❌ 未探测，默认 UTF-8 | — |
| 时间轴偏移 | ❌ `subtitleOffset` 未开启 | — |
| 内嵌字幕轨道 | ❌ 无 ffmpeg，无浏览器 demux | 镜像未装 ffmpeg |
| 在线字幕检索 | ⚠️ 有客户端（assrt），但只用于**获取内容时**落盘，未用于播放 | `providers/subtitle-provider.ts` |
| 字幕内容缓存 | ❌ 无 | — |

### 3.2 四个现存缺陷（优先修复）

**缺陷 1：SRT 被当作 VTT**

```ts
// mediary-player-core.tsx:166
type: (defaultSub.format === "ass" ? "ass" : "vtt") as "ass" | "vtt",
```

ArtPlayer 的 `srtToVtt()` 只在 `type === "srt"` 时调用（`artplayer.mjs:502`）。声明成 `vtt` 后，SRT 文本既不补 `WEBVTT` 头、时间戳的逗号也不转点，浏览器解析不出 cue → **整条字幕不显示**。这是"字幕功能看起来存在但实际不可用"的最可能原因。

**缺陷 2：语言恒为 `und`**

扫描时 `language: "und"` 写死。多字幕文件（`Movie.zh-CN.ass`、`Movie.eng.srt`）无法按语言排序或自动选中文。

**缺陷 3：只加载第一条**

`subtitles[0]` 直接作为默认轨，没有 `art.subtitle.switch()` 入口。用户即使盘里有中英双语，也只能看到排序第一的那条。

**缺陷 4：无偏移微调**

ArtPlayer 原生支持 `subtitleOffset`，本项目未开启。

### 3.3 目标分层（L0–L4）

| 层 | 目标 | 依赖 | 成本 |
| :--- | :--- | :--- | :--- |
| **L0** | 本地字幕"能用"：修 4 个缺陷 | 无 | 0.5 天 |
| **L1** | 本地字幕"选得对"：语言识别 + 候选打分（版本/分辨率/发布组）+ 多轨切换 | L0 | 1–2 天 |
| **L2** | 在线匹配：assrt 按片名/季集检索 → 选中 → 代理内容 → 即时显示（不落盘） | L1 | 3–5 天 |
| **L3** | 内嵌轨道：MKV/MP4 内部字幕轨 | ffmpeg 或浏览器 demux | 5–10 天（成本高） |
| **L4** | 自动调轴：偏移/拉伸校正 | ffsubsync / alass（服务端）或纯前端偏移 | 2–3 天（可选） |

**建议节奏**：L0 → L1 立即做（合计约 2–3 天，纯前端 + 扫描器小改，零新依赖）；L2 作为下一迭代（assrt 已具备，主要工作量在服务端取内容与缓存）；L3 单独评估（见 3.7 成本分析）；L4 先只做"手动偏移"，自动调轴延后。

### 3.4 数据模型与流程

**存储**：不建议新建大表。在现有 `episode.subtitles`（`SubtitleTrackInfo[]`）上扩展字段即可：

```ts
interface SubtitleTrackInfo {
  id: string;
  language: string;        // 由 und 升级为 zh-Hans / zh-Hant / en / ja …
  title: string;
  format: "srt" | "ass" | "vtt" | "pgs" | "sub";
  type: "embedded" | "external" | "online";  // 新增 online
  source?: "local" | "assrt" | "opensubtitles"; // 新增：来源可追溯
  score?: number;          // 新增：匹配得分（排序用）
  url?: string;
  fileId?: string;
}
```

在线字幕不落 `episode.subtitles`（避免污染扫描结果），而是运行时通过独立接口获取，按 `storageId:fileId` 做短期缓存。

**流程（L2）**：

```
播放器打开
  → 本地轨（episode.subtitles）直接可用
  → 用户点「搜索字幕」或本地无中文轨时自动触发
  → GET /api/subtitles/search?episodeId=...        (assrt search，按 TMDB 标题 + 季集)
  → 返回候选（id/title/lang/评分/字幕组）
  → 用户选中 → GET /api/subtitles/fetch?candidateId=...&fileIndex=n
       服务端：assrt detail → 取直链 → 下载内容（≤2MB）→ 编码归一 → 缓存 → 返回
  → 前端 art.subtitle.switch(blobUrl, { type, name })
```

**关键约束**：assrt 的下载直链**约 5 分钟后失效**（`pan123-storage-executor.ts` 注释已记录），因此必须"取到即下载并缓存内容"，不能把直链交给浏览器长期持有。

### 3.5 设计模式评估

| 模式 | 落点 | 必要性 |
| :--- | :--- | :--- |
| **策略 Strategy** | `SubtitleSource`：`LocalExternalSource` / `AssrtSource` / `OpenSubtitlesSource` / `EmbeddedSource`，统一 `search() → candidates[]` 与 `fetch(candidate) → content` | **必要**：来源会持续增加，且各有配额与失败语义 |
| **适配器 Adapter** | `SubtitleFormatAdapter`：`srt→vtt`、`ass→ass`、`pgs→(不支持)`；`EncodingAdapter`：BOM/UTF-8 校验 → 回退 GBK/GB18030 | **必要**：格式与编码是正交的两件事，混在一起必然失控 |
| **责任链 Chain** | 候选排序：语言匹配 → 季集匹配 → 版本/发布组 → 评分 → 新鲜度，逐级加权 | 必要（替代"if 堆叠"） |
| **状态机 State** | `SubtitleState`：`idle → searching → candidates → fetching → ready / error`，与播放状态机**解耦但可联动**（字幕 ready 不阻塞播放） | 必要（在线检索是异步多阶段，散落 boolean 会重演播放器老问题） |
| **装饰器 Decorator** | `CachedSubtitleSource`、`RateLimitedSubtitleSource` | 可选（有配额来源时再加） |

**不建议**：为字幕引入全局状态库；也不建议把字幕状态塞进播放状态机（两者生命周期不同：换字幕不应重置播放状态）。

### 3.6 业界方案对比

| 方案 | 匹配方式 | 显示方式 | 可借鉴点 |
| :--- | :--- | :--- | :--- |
| **Bazarr**（*arr 生态） | 多 provider + 评分（发布组、分辨率、帧率、哈希）+ 自动调轴（ffsubsync/alass） | 落盘为外挂文件 | 评分维度与"软失败不阻塞主流程" |
| **Jellyfin / Emby** | 内置 provider 搜索 + 内嵌轨枚举 | 客户端选轨，实时转封装 | 内嵌轨与在线轨统一成"轨道列表" |
| **Plex** | OpenSubtitles agent | 客户端选轨 + 偏移 | 偏移控制放在客户端 |
| **Infuse / VidHub** | 自动在线匹配（OpenSubtitles） | 自动加载 + 一键切换 | 默认自动、失败静默 |
| **参考脚本** | 读取容器内轨（自研 demux） | 文本/ASS/PGS 渲染器 | 内嵌轨的浏览器方案；PGS 需位图渲染 |
| **本项目现状** | 同目录前缀匹配 | ArtPlayer 单轨 | — |

**结论**：业界共识是"**统一轨道列表 + 来源可追溯 + 自动选轨失败静默 + 客户端可切换/可偏移**"。本项目应先把"轨道列表"这一抽象建立起来（本地/在线/内嵌同构），再逐个接来源。

### 3.7 内嵌字幕（L3）成本分析

当前镜像**未安装 ffmpeg**（`Dockerfile`/`Dockerfile.dev` 均无），因此无法服务端抽轨。三条路：

| 方案 | 成本 | 风险 |
| :--- | :--- | :--- |
| 镜像内置 ffmpeg（`ffprobe` 列轨 + 抽轨） | 镜像 +60–80 MB；抽轨需下载整个文件或至少 `moov` + 目标轨数据 | 网盘下载成本高；跨容器架构（multi-arch）需静态构建 |
| 浏览器 demux（参考脚本路线） | 自研 Matroska/MP4 解析 + 文本轨抽取，约 1–2 周 | 复杂度高，但与直链播放天然契合（只需 Range） |
| 暂不支持，仅提示"该片含内嵌字幕" | 0 | 用户需外部工具 |

**建议**：L3 先做"**探测并提示**"（扫描阶段用文件头解析判断是否存在内嵌字幕轨，成本低），不做抽取；待 L2 稳定后再评估 ffmpeg sidecar。

### 3.8 可复用资产

**本仓库已有**

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| assrt 客户端（search + detail） | `packages/workflow/src/providers/subtitle-provider.ts` | L2 检索与取链，**零新增依赖** |
| assrt token 设置与状态胶囊 | `features/settings-system/components/assrt-token-form.tsx` | 已有配置入口 |
| 字幕落盘能力（获取流程用） | `acquisition-v2/real-storage-adapter.ts`（`transferSubtitle`） | L2 可选"另存到网盘" |
| 字幕代理通道 | `/api/strm/play/...&delivery=proxy` | 本地外挂字幕取内容 |
| ArtPlayer 字幕能力 | `srtToVtt` / `assToVtt` / `subtitle.switch` / `subtitleOffset` | L0/L1 全部能力，无需引入解析库 |
| 播放状态机范式 | `playback-state-machine.ts` | `SubtitleState` 直接照搬写法 |
| 单飞与限流 | `SingleFlight`、`withBrandPacing` | 在线检索去重与限速 |

**第三方（按需）**

| 库/服务 | 说明 | 建议 |
| :--- | :--- | :--- |
| OpenSubtitles REST v1 | `Api-Key` + `User-Agent`；**未登录仅 5 次下载/IP/24h**，搜索不限；下载返回临时直链；默认 SRT/UTF-8 | 作为**可选**来源，需用户自备 key；不作默认 |
| SubDL | 支持 `tmdb_id` 精确匹配 | 备选来源 |
| `srt-parser-2` / `ass-compiler` | 纯 JS 解析 | **不需要**：ArtPlayer 已内置转换 |
| `ffsubsync` / `alass` | 音频/字幕对齐 | L4 再做；服务端需 Python/C++ 运行时 |
| `iconv-lite` / `chardet` | 编码转换与探测 | **不需要**：Node 与 Chromium 的 `TextDecoder` 原生支持 `gbk`/`gb18030` |

### 3.9 性能、安全与合规

| 维度 | 风险 | 缓解 |
| :--- | :--- | :--- |
| 性能 | 字幕文件通常 20–200 KB，代理开销可忽略 | 内容缓存（按 `candidateId` + 文件序号），上限 2 MB/条 |
| 限流 | assrt 有配额；OpenSubtitles 下载限额极低 | 复用 `withBrandPacing`；在线检索加 `SingleFlight`；失败静默降级到本地轨 |
| 直链时效 | assrt 直链 ~5 分钟过期 | 服务端"取链即下载"，不把直链透给浏览器 |
| SSRF | 在线来源返回任意 URL | 白名单域名（`*.assrt.net`、`api.opensubtitles.com` 等）+ 禁止内网地址 + 大小上限 |
| 编码炸弹 | GBK 误解码产生乱码 | BOM → UTF-8 校验 → `gb18030` 回退；解码后校验替换字符比例 |
| XSS | ASS/HTML 标签注入 | ArtPlayer `escape` 默认 true，保持开启；在线内容仅当纯文本处理 |
| 版权 | 字幕是第三方作品 | 保留来源与作者信息，仅个人使用，不做二次分发；UI 标注来源 |
| 误配 | 自动匹配错片 | 候选列表展示"标题/语言/字幕组/评分"，默认不自动落盘，只即时显示 |

### 3.10 实施计划与验收

| 期 | 内容 | 交付 | 验收 |
| :--- | :--- | :--- | :--- |
| **P0**（0.5 天） | 修 4 缺陷：SRT 类型、`subtitleOffset`、多轨切换、语言识别 | 播放器 + 扫描器小改 | 同目录 SRT 能显示；双语可切换；偏移可调 |
| **P1**（2 天） | 轨道列表抽象 + 候选打分 + 来源标注 | `subtitle-tracks.ts`（纯函数）+ 单测 | 打分单测覆盖；UI 显示来源 |
| **P2**（3–5 天） | 在线匹配（assrt）+ 内容代理 + 缓存 | `/api/subtitles/*` + 播放器入口 | 无本地中字时能一键搜到并显示；5 分钟内不重复请求 |
| **P3**（可选） | 内嵌轨探测提示 | 扫描器增加 `hasEmbeddedSubs` | 只提示，不抽取 |
| **P4**（可选） | 自动调轴 | 服务端 ffsubsync 或纯前端偏移曲线 | 仅手动偏移先行 |

**指标**：字幕可用率（有字幕文件的单集中实际能显示的比例）、自动选轨命中率（选中的语言符合预期）、在线检索 P95 时延、字幕导致的播放失败率（目标 0，字幕失败必须不影响视频）。

---

## 4. 附：调研方法

- 代码测绘：`library-scanner.ts`、`subtitle-provider.ts`、`mediary-player-core.tsx`、`api/library/play/[episodeId]/route.ts`、`artplayer` 5.4 类型与产物。
- 参考实现：油猴脚本 `src/features/subtitles/*`（选轨、预取、文本/ASS/PGS 渲染）与 `src/features/media/*`（demux）。
- 外部资料：OpenSubtitles REST API 官方文档（鉴权头、限额、编码与格式、moviehash）；Bazarr 官方 Wiki；ffsubsync/alass 公开说明。
