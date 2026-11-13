# 播放器播放统计（Telemetry）与启动延迟优化 · 可行性与方案调研

> 调研日期：2026-11-13
> 参考实现：`E:\WorkProject\Node\_BrowserExtend\【油猴脚本】\视频播放器优化v2`（下称「参考脚本」）
> 实测环境：开发实例 `mediary-dev`（端口 3020，提交 `5f1ff825`）
> 主机地址统一以 `<DEV_HOST>` 占位；真实凭据仅存于 `env/.envdev`。

---

## 1. 结论摘要

两个诉求**均可行**，且**无需引入新的重依赖**。

| 诉求 | 可行性 | 核心判断 |
| :--- | :--- | :--- |
| ① 显示播放元信息（进度 / 缓冲 / 网络 / 解码质量） | 高 | 数据源全部来自浏览器原生 API 与 ArtPlayer 既有事件，`ArtPlayer 5.4` 自带 `setting` 面板与 `layers` 图层，可直接承载 HUD；参考脚本的 `PlaybackDiagnostics` 提供了「有界、脱敏、冻结快照」的成熟范式，可直接借鉴其字段设计与安全约束 |
| ② 缩短「点播放 → 出画面」的等待 | 高 | 实测瓶颈**不在前端渲染**，而在 `/api/strm/play` 的 **TTFB ≈ 2.1–2.5 s**。根因是「`pickCode` 未透传 + 115 品牌漏桶 1.2 s/次 + 逐请求新建连接 + 无预热」。短期改动（透传 pickCode + 预热 + 连接复用）预计可把关键路径压缩到 **0.3–0.8 s** |

**设计模式结论**：策略模式与状态机**都有必要**，但都不是"为了模式而模式"——当前代码已经自发形成了策略（`StorageStreamResolver` 多实现）与装饰器（`SingleFlight`、`withBrandPacing`），缺的是**统一的状态机**与**可观测的适配层**。建议按"补状态机 → 抽遥测适配器 → 固化投送策略"的顺序演进，而不是重写播放器。

---

## 2. 现状测绘（实测数据）

### 2.1 启动时间线（开发实例，真实点击「立即播放」）

| 节点 | 相对点击耗时 | 说明 |
| :--- | ---: | :--- |
| `video` 元素创建 | **117 ms** | 前端挂载很快，不是瓶颈 |
| `GET /api/library/play/{episodeId}` | 7–44 ms | 仅 SQLite 查询与责任链裁决，可忽略 |
| `GET /api/strm/play/{taskId}/{fileId}`（首字节） | **2088–2477 ms** | **瓶颈所在**，两次测量均稳定在此区间 |
| 首个 `progress` 事件 | ≈ 2.6 s | 与上一条基本重合 |
| `loadedmetadata` / `canplay` | 未到达 | 当前 115 `refresh_token` 失效，`readyState` 停留 0、`videoWidth` 0 |
| 浏览器重试 | 首请求 `ERR_ABORTED` 后立即重发 | 播放器探测被慢响应拖到超时后重连 |

> 证据：`test-results/startup-timeline.json`、`test-results/measure-playback-startup.mjs`。

### 2.2 关键结论

- 用户感知的"打开后要等一会"，**几乎全部**是服务端直链解析与首字节等待，而非 React 水合或 ArtPlayer 初始化。
- 该延迟是**确定性**的（两次测量差异 < 400 ms），说明来自固定环节的串行等待，而非网络抖动。

---

## 3. 启动慢的根因分解

### 3.1 根因一：`pickCode` 未透传，导致最优路径被整条跳过（影响最大）

`apps/web/app/api/library/play/[episodeId]/route.ts:64`：

```ts
const streamUrl = `/api/strm/play/${episode.storageId}/${episode.fileId}?name=...`;
```

URL 里**没有带 `pickCode`**，而单集记录里其实已经存了（`library-scanner.ts:419` 写入，`sqlite-media-library.ts` 持久化），流接口也支持读取该参数（`route.ts:314`）。

连锁后果有两层：

1. **115 开放平台路径被直接放弃**：`stream-resolver.ts:118` 的守卫是
   `if (!isPan115OpenOAuthValid(openOAuth) || !input.pickCode) return null;`
   没有 `pickCode` 就永不尝试 Open API。Open 客户端**没有套品牌限速**，一次 HTTP 即可拿到直链。
2. **Cookie 路径多付一次调用**：`pan115-cookie-client.ts:382` 的 `resolveDownloadTarget()` 在缺 `pickCode` 时先 `getFileInfo(fileId)`，多一次 API 往返 + 一次限速放行。

### 3.2 根因二：115 品牌漏桶 1.2 s/次，串行叠加

`packages/shared/src/rate-limiter.ts:102`：`pan115: intervalMs: 1200`（漏桶，任意两次放行至少间隔 1.2 s）。

当前 Cookie 路径的调用序列（无 `pickCode`）：

```
getDownloadUrl ──(放行, t=0)
  ├─ getFileInfo      ──(等 1.2s)
  └─ fetchJson(downurl) ──(再等 1.2s)
```

即**纯等待 ≈ 2.4 s**，与实测 TTFB 2.1–2.5 s 高度吻合。这是本次"慢"的主因。

> 补充：`request115ProApiDownloadUrl({ fetchJson: this.fetchJson })` 传入的是经 `Proxy` 包装后的方法（`brand-pacing.ts`），因此 `fetchJson` 调用本身也会再消耗一次放行额度，实际等待可能比 2.4 s 更长。

### 3.3 根因三：`Connection: close` 逐请求新建连接

`pan115-cookie-client.ts:445` 在请求头里固定写入 `Connection: close`。若运行时遵循该头，则每次 API 调用都要重新 TCP + TLS 握手（国内通常 80–300 ms/次），与根因二的等待**串行叠加**。

### 3.4 根因四：代理模式首字节 = 上游 TTFB，且没有分片预取

`/api/strm/play` 的 proxy 分支（`route.ts:142-181`）是"收到请求 → `fetch` 上游 → 原样透传 body"，存在三点欠缺：

- **无连接复用与预热**：首个字节必须等上游 CDN 完成 TLS + 鉴权 + 定位。
- **无 Range 合并**：播放器探测阶段常并发发起 5–10 个 Range 请求（`single-flight.ts` 的注释已明确记录这一现象），但现有 `SingleFlight` **只合并直链解析**（`stream-resolver.ts:41`），**不合并字节流**，导致同段数据被重复向上游拉取。
- **无首部预取**：MKV / 非 faststart MP4 的 `moov` 常在文件尾部，浏览器需要额外一次尾部 Range 才能拿到时长与轨道信息，进一步推迟 `loadedmetadata`。

### 3.5 根因五：缺少预热，所有成本都压在"点击播放"这一刻

列表页/详情页打开时不做任何直链解析预热，`strm_link_cache`（`sqlite-schema.ts:331`，TTL 2 h）只在**首次播放请求**时被动填充。用户点击后才开始付 2 s+ 的代价。

### 3.6 根因六：失败兜底偏慢，且缺少阶段性反馈

`mediary-player-core.tsx:321` 在 **8 s** 后才判定 `fallback`。这段窗口里 UI 只有加载指示，没有"正在解析直链 / 正在连接 CDN / 正在读取元数据"的分段反馈，用户主观上会把"等待"读成"卡死"。

---

## 4. 功能一：播放统计 HUD 可行性

### 4.1 数据源矩阵（全部为原生能力，零新增依赖）

| 指标 | 数据源 | 备注 |
| :--- | :--- | :--- |
| 播放进度 / 时长 | `video.currentTime` / `video.duration` | 已有控制条，HUD 只是补充精确值 |
| 缓冲裕量 | `video.buffered`（`TimeRanges`） | 取 `buffered.end(i) - currentTime`；多段缓冲需全部列出 |
| 就绪 / 网络状态 | `video.readyState`（0–4）、`video.networkState`（0–3） | 排障第一指标 |
| 丢帧 / 解码质量 | `video.getVideoPlaybackQuality()` | `totalVideoFrames`、`droppedVideoFrames`、`corruptedVideoFrames` |
| 实时吞吐 | `PerformanceResourceTiming`（`transferSize` / `duration`） | 代理模式下即 `/api/strm/play` 的实际下行速率 |
| 停滞检测 | `video:waiting` / `video:stalled` / `video:timeupdate` 时间差 | 参考脚本用「进度 3 s 未推进」判定停滞 |
| 投送模式与决策来源 | 现有 `deliveryMode` / `deliverySource` / `deliveryReason` | 已在 R6 常驻展示，可并入 HUD |
| 错误码 | `video.error.code`（1–4） | 与 `art.on("error")` 的降级链路对齐 |

**能力边界（必须说清）**：浏览器**无法**直接从 `<video>` 读出容器级/编码级元信息——`codec` 字符串、精确码率、音轨数量、字幕轨道清单、HDR 标识都拿不到。这些只有三条路：

1. **服务端解析**（`ffprobe` 或现有扫描阶段的结果）→ 随 `/api/library/play` 一并返回（推荐，成本最低）；
2. **前端解析容器头**（`mp4box.js` / 自研 EBML 解析）→ 体积与复杂度代价大；
3. **MSE 路径**（`MediaSource.isTypeSupported`）→ 仅适用于走 MSE 的场景，直链原生播放用不上。

因此建议 HUD 分两层：**「播放层指标」**（浏览器原生，实时、零成本）与**「媒体层指标」**（服务端一次性给出，随播放接口返回）。参考脚本之所以能显示 `videoCodec` / `audioTrackCount` / `HDR`，正是因为它自己在浏览器里做了 demux（`src/features/media/*`），本项目不应为此重造。

### 4.2 与参考脚本的对比与可借鉴点

参考脚本的 `src/features/playback/diagnostics.ts` 是一套**生产级**的诊断模型，值得直接借鉴的不是"字段多"，而是三条工程约束：

1. **有界（bounded）**：失败记录最多 8 条、周期最多 64 条、缓冲区间最多 8 段，避免长播内存膨胀。
2. **脱敏（sanitized）**：`sanitizeToken` / `sanitizeMessage` 会把 URL、`token=`、`secret` 一律替换为占位符——这一点对本项目**尤其重要**，因为 115 直链带签名参数，绝不能进日志或截图。
3. **冻结快照（frozen snapshot）**：`get snapshot()` 返回 `Object.freeze` 的只读结构，UI 与上报都读同一份，杜绝"面板显示与日志不一致"。

其 `ReadStatistics`（`rangeRequests` / `cacheHitBytes` / `sharedPendingBytes` / `byPurpose`）还提供了**按用途归因**的读放大指标，正好可以映射到本项目的"直链解析 / 首部探测 / 播放读取 / 字幕读取"。

### 4.3 UI 形态建议

利用 ArtPlayer 内置能力，**不新增依赖**：

- 入口：`art.setting.add({ html: "播放统计", selector: [关闭 / 精简 / 详细] })`（`node_modules/artplayer/types/setting.d.ts` 已确认支持 `selector` + `onSelect`）。
- 展示：`art.layers.add()` 挂一个半透明 HUD，或复用现有底部常驻行（R6 的 `player-delivery-reason`）扩展为多行。
- 刷新：`timeupdate` 节流到 500 ms（或 `requestAnimationFrame` 对齐），**禁止**在 `timeupdate` 里做 DOM 全量重建。
- 三档语义：
  - **精简**：进度 / 缓冲裕量 / 投送模式
  - **详细**：再加 `readyState`、`networkState`、实时吞吐、丢帧、直链解析耗时
  - **关闭**：默认，保持现状

### 4.4 性能与安全约束

- 采样与渲染必须**解耦**：采样在事件回调里写环形缓冲，渲染按 500 ms 节流。
- HUD 关闭时**零开销**（不挂监听、不开定时器）。
- 面板内**禁止**展示完整直链、Cookie、`pickCode`；如需排障，只显示长度与前缀。
- 上报（若做）走 `reportPlaybackMetric` 的 opt-in 约定（`localStorage.mediary.player.metrics`），默认静默。

---

## 5. 功能二：启动延迟优化方案

按"投入/收益/风险"分三档，建议**先做 S 档**，因为它能吃掉本次实测延迟的绝大部分。

### 5.1 S 档：低风险、当天可验证

| # | 措施 | 预期收益 | 风险 |
| :-- | :--- | :--- | :--- |
| S1 | **透传 `pickCode`**：`/api/library/play` 生成 `streamUrl` / `proxyUrl` 时带上 `episode.pickCode` | 开放平台路径恢复可用（1 次调用、无限速）；Cookie 路径少 1 次调用 | 极低；参数已存在，接口已支持 |
| S2 | **打开详情/列表时预热直链**：进入单集面板即触发一次 `HEAD /api/strm/play/...`（复用 `SingleFlight` 防抖） | 把 1.2–2.4 s 从关键路径挪到浏览阶段，点击后 ≈ 0.2–0.5 s | 低；需限频，避免触发网盘风控 |
| S3 | **去掉 `Connection: close`**，改用长连接复用 | 每次调用省 80–300 ms 握手 | 低；需回归验证 115 侧无异常 |
| S4 | **分段 loading 文案**：把 8 s 单点兜底改为 `解析直链 → 连接 CDN → 读取元数据` 三阶段计时，超时阈值分级 | 主观等待感显著下降；排障有据 | 极低 |
| S5 | **缓存命中时不重复解析**：确认 `strm_link_cache` 在 proxy/redirect 两模式下的 key 不互相污染 | 二次播放接近 0 解析成本 | 低 |

> S1 的收益依赖 115 Open OAuth 有效。当前实例 `refresh_token` 已失效（`40140137`），需重新授权后实测确认；即便 OAuth 不可用，S1 仍能省掉 `getFileInfo` 的 1.2 s。

### 5.2 M 档：结构性优化（1–2 周）

| # | 措施 | 说明 |
| :-- | :--- | :--- |
| M1 | **服务端 Range 共享池** | 借鉴参考脚本 `shared-range-pool.ts`：同 key 的并发 Range 合并、热段内存缓存、在途请求共享、按用途归因统计。直接解决"播放器并发探测被逐个串行化" |
| M2 | **首部优先预取** | 首次请求时优先拉取文件头（含 `moov` / MKV 头部），再拉播放位置；对非 faststart MP4 显式补一次尾部 Range |
| M3 | **代理链路 keep-alive + 流式背压** | 上游 `fetch` 复用连接；下游按 `highWaterMark` 控制，避免 Next.js 层缓冲放大内存 |
| M4 | **预热策略中心化** | 把"何时预热、预热多少字节、并发上限"收进一个 `PlaybackWarmupPolicy`，复用 115 漏桶，绝不绕过限速 |
| M5 | **失败快速降级** | 直链解析失败时不等 8 s，按错误类型（鉴权失效 / 限流 / 超时）分别 1.5 s / 3 s / 8 s 降级到 proxy 或提示重新授权 |

### 5.3 L 档：可选、成本高，暂不建议

- 服务端转码 / ABR（HLS）：能解决 MKV/HEVC 兼容与码率自适应，但引入 ffmpeg 常驻进程、CPU 与磁盘成本，与"零外部依赖单文件 SQLite"的定位冲突。
- 边缘 CDN：家用场景收益有限。

### 5.4 预期收益汇总

| 场景 | 现状 | S 档后（估） | S+M 档后（估） |
| :--- | ---: | ---: | ---: |
| 首次播放（冷缓存） | 2.1–2.5 s | 0.3–0.8 s | 0.2–0.5 s |
| 二次播放（热缓存） | 0.3–0.6 s | 0.1–0.3 s | 0.1 s 级 |
| 拖动 seek | 未测 | — | 明显改善（Range 池） |

> 估算依据：S1 省 1.2 s（Cookie 路径）或 ~2 s（Open 路径），S3 省 0.1–0.3 s，S2 把剩余成本移出关键路径。**需在 115 重新授权后以 `T_first_frame` 实测校准**。

---

## 6. 设计模式评估

### 6.1 现状：已具备的基础

| 模式 | 现有落点 | 评价 |
| :--- | :--- | :--- |
| 策略 Strategy | `StorageStreamResolver` 接口 + `ProductionStorageStreamResolver` / `MockStorageStreamResolver`（`stream-resolver.ts`） | 已成型，按 provider 分派 |
| 装饰器 Decorator | `SingleFlightStreamResolver`、`withBrandPacing` | 已成型，职责单一 |
| 责任链 Chain of Responsibility | `resolveDeliveryMode`（session > binding > library > global > driver 约束） | 已成型，但**只裁决"用哪种投送"，不裁决"如何优化"** |
| 状态机 State Machine | 仅 `player-viewport.ts` 的 `pending/fitted/fallback`（R3） | **缺失**：播放生命周期仍散落在 `useState` + `useRef` + 多个 `useEffect` |

### 6.2 建议一：统一播放状态机（收益最高）

当前播放器把「布局阶段」「是否降级」「是否切流」「是否暂停」混在多个状态里，导致：兜底计时器与 `video:waiting` 逻辑重复、排障时无法回答"卡在哪一步"。

建议引入单一状态机（与 R3 的 `layoutPhase` 合并，而非叠加）：

```
idle
  └─ resolving      (请求 /api/library/play + 直链解析)
       ├─ connecting (首字节 / TTFB)
       │    └─ buffering (有数据、无首帧)
       │         └─ playing ⇄ stalled
       │              └─ seeking → buffering
       └─ fallback   (proxy 兜底)
            └─ error (需重新授权 / 网络不可用)
```

落地要点：

- 状态迁移**只允许**在状态机内部发生，UI 只订阅快照。
- 每个状态带 `enteredAt`，天然产出分段耗时（直接喂给 HUD 与埋点）。
- 与现有 `layoutPhase` 的关系：`fallback` 是布局维度，播放状态机是生命周期维度，两者用**正交字段**表达，不要互相覆盖（这正是 R3 之前"诊断标记残留"的教训）。

### 6.3 建议二：遥测适配器（Adapter）

定义 `PlayerTelemetryAdapter`，把"从播放器取数"与"如何展示/上报"解耦：

```
ArtPlayerAdapter   → 读 art.video / art.on(...)
NativeVideoAdapter → 读 <video>（未来 hls.js / shaka 接入时新增）
NoopAdapter        → HUD 关闭时零开销
```

好处：未来若为 HLS/转码引入 `hls.js`，HUD 与埋点无需改动，只需新增一个适配器——这正是参考脚本 `presentationMode`（`native-video` / `native-canvas` / `software-canvas`）的可借鉴之处。

### 6.4 建议三：投送策略从"裁决"扩展为"裁决 + 优化参数"

现有 `resolveDeliveryMode` 只回答 `redirect | proxy`。建议让策略对象同时给出**该模式下的优化参数**：

```
DeliveryDecision {
  mode, source, reason,
  warmup: { enabled, headBytes, concurrency },
  rangePool: { enabled, maxCacheBytes },
  timeout: { resolveMs, ttfbMs, metadataMs }
}
```

这样"115 走 proxy + 预热 4 MB + 3 s 超时"与"Quark 走 proxy + 预热 1 MB + 5 s 超时"可以由策略各自声明，而不是散落在路由里的魔法数字。

### 6.5 反模式提醒

- **不要**为 HUD 引入全局状态库（Zustand/Redux）：播放器内部高频采样，进全局 store 会造成整树重渲染。
- **不要**在 `timeupdate` 里直接 `setState` 全量指标：500 ms 节流 + 环形缓冲。
- **不要**把预热放进请求路径同步执行：预热必须是 fire-and-forget，失败静默。

---

## 7. 业界方案对比

| 方案 | 统计/诊断能力 | 启动优化手段 | 对本项目的可借鉴度 |
| :--- | :--- | :--- | :--- |
| **Shaka Player** | 官方 `player.getStats()`：分辨率、带宽估计、解码帧、丢帧、缓冲 | 预加载、ABR、分段请求 | 高（字段设计可直接对标） |
| **hls.js** | 无官方 HUD，demo 提供 stats 面板；`bandwidthEstimate`、`levels`、`latency` 可读 | 分片预取、`maxBufferLength`、ABR | 中（仅 HLS 场景） |
| **dash.js** | `getMetricsFor('video')` + `getQualityFor()` | 分段调度、ABR | 中 |
| **video.js (VHS)** | `player.tech().vhs.stats` | 预加载、缓冲区目标 | 中 |
| **Jellyfin / Emby** | 服务端 `ffprobe` 元数据 + 播放会话看板 | Direct Play 优先、转码预热、`moov` 预读 | **高**（与本项目同为"自建 + 直链"） |
| **Plex** | 会话看板（码率/转码原因/带宽） | 直连优先 + 转码决策 | 高（决策可解释性） |
| **Infuse / VidHub** | 播放 HUD（码率、缓冲、网络） | 直链 + 本地缓存 | 高（HUD 形态） |
| **AList / CloudDrive2** | 以日志为主 | 302 直链为主、代理兜底 | 中（架构同源） |
| **参考脚本** | 极详尽（读放大、HDR、后端策略、失败链） | Range 共享池、按用途归因、字幕扫描 | **最高**（同一问题域） |

**共性结论**：主流方案都不是"加一个 loading 动画"，而是三件事——
① 把元数据/直链**提前**（预热）；② 把字节流**分片并复用**（Range 池）；③ 把状态**显式化**（可观测，才能优化）。

---

## 8. 可复用资产清单

### 8.1 本仓库已有（优先复用，避免重复造轮子）

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| `SingleFlight` | `packages/workflow/src/strm/single-flight.ts` | 直链解析防抖；可扩展为 Range 合并 |
| `strm_link_cache` 表 | `packages/workflow/src/persistence/sqlite/sqlite-schema.ts:331` | 直链缓存（2 h TTL），预热写入即可 |
| 品牌限速 `withBrandPacing` | `packages/workflow/src/storage/brand-pacing.ts` | 预热必须复用，禁止绕过 |
| `resolveDeliveryMode` 责任链 | `packages/workflow/src/strm/delivery-mode-resolver.ts` | 投送策略扩展点 |
| `PlaybackMetrics`（opt-in） | `apps/web/features/player/playback-metrics.ts` | 埋点通道，直接扩展指标名 |
| ArtPlayer `setting` / `layers` / 事件 | `node_modules/artplayer/types/*` | HUD 载体，零新增依赖 |
| 诊断弹窗样式 | `apps/web/features/storage-drives/components/storage-diagnostics-modal.tsx` | 视觉与交互一致性 |
| `player-viewport.ts` 状态机范式 | `apps/web/features/player/player-viewport.ts` | 新状态机的写法样板（纯函数 + 单测） |

### 8.2 第三方（按需，非必需）

| 库 | 体积 | 建议 |
| :--- | :--- | :--- |
| `mp4box.js` | ~200 KB | 仅当需要精确解析 `moov`/轨道信息时引入；当前可用原生 `loadedmetadata` 替代 |
| `mediainfo.js`（WASM） | ~2 MB | **不建议**：为 HUD 引入 WASM 解析器收益不成比例 |
| `hls.js` | ~150 KB | 仅在未来做转码/ABR 时引入 |
| `stats.js` | ~10 KB | 不适合网络指标（只擅长 FPS），可借鉴其面板渲染节流 |

**结论：HUD 与启动优化都不需要新增运行时依赖。**

---

## 9. 欠缺与风险

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 115 风控 | 预热会额外消耗 API 调用，可能触发限流/封号 | 强制复用漏桶；预热并发 ≤ 1；失败静默不重试 |
| 代理带宽 | Range 池与预取会增加服务端内存与上行带宽 | 设 `maxCacheBytes`（建议 32–64 MB）+ LRU 淘汰 |
| 隐私泄露 | 直链含签名，误入日志/截图即等于泄露 | 沿用参考脚本的 `sanitizeToken` 思路，白名单字段输出 |
| 兼容性 | MKV 在部分浏览器需转封装；HEVC 依赖硬件 | HUD 显示 `readyState` 与错误码，先让问题可见，再决定是否转码 |
| 观测缺位 | 目前无 `T_link_resolve` / `T_ttfb` 等分段指标，优化无法量化 | 随状态机一并落地埋点（见 §10） |
| 过度设计 | 状态机 + 适配器 + 策略三件套同时上，改动面过大 | 分三期，每期可独立验收、可回滚 |

---

## 10. 实施计划与验收指标

### 10.1 分期

| 期 | 内容 | 交付物 | 验收 |
| :--- | :--- | :--- | :--- |
| P1（1–2 天） | S1 透传 `pickCode`、S3 去 `Connection: close`、S4 分段文案 | 路由与 client 小改 | `TTFB` 下降 ≥ 1 s；无新增 401/429 |
| P2（3–5 天） | 播放状态机 + 遥测适配器 + HUD 三档 | `playback-state-machine.ts`、`telemetry-adapter.ts`、HUD 组件 + 单测 | 状态迁移单测覆盖；HUD 关闭时零监听 |
| P3（1–2 周） | Range 共享池、首部预取、预热策略中心 | `range-pool.ts`、`warmup-policy.ts` | seek 与二次播放显著改善；内存上限生效 |

### 10.2 度量指标（建议随状态机一起埋）

| 指标 | 定义 | 目标 |
| :--- | :--- | :--- |
| `T_link_resolve` | 直链解析耗时 | < 400 ms（Open）/ < 1.3 s（Cookie） |
| `T_ttfb` | `/api/strm/play` 首字节 | < 800 ms |
| `T_metadata` | `loadedmetadata` | < 1.5 s |
| `T_first_frame` | 首帧（已有埋点名） | < 2 s |
| `rebuffer_ratio` | 卡顿时长 / 播放时长 | < 1% |
| `startup_fail_rate` | 启动失败占比 | < 1% |

### 10.3 回归口径

- 单测：状态机纯函数化（参照 `player-viewport.test.ts` 的写法），覆盖 `resolving → connecting → buffering → playing` 与三条失败分支。
- 实机：复用 `test-results/browser-acceptance/acceptance-full.mjs`，新增 `T_ttfb` / `T_metadata` 断言。
- 门禁：`npm run gate`（含 `gate:security`，HUD 文案不得出现真实直链）。

---

## 11. 附录：实测方法

```bash
# 启动耗时分解（dev 实例）
BASE="http://<DEV_HOST>:3020" node test-results/measure-playback-startup.mjs
# 产出：test-results/startup-timeline.json（网络时序 + video 事件时间线）
```

脚本采集三类数据：

1. `/api/library/play/*` 与 `/api/strm/play/*` 的 `responseStart - requestStart`（TTFB）；
2. `video` 元素的 `loadstart / loadedmetadata / loadeddata / canplay / playing / error` 时间线；
3. 终态 `readyState` / `networkState` / `duration` / `videoWidth` / `buffered`。

> 当前 115 凭据失效导致终态为 `readyState=0`、`videoWidth=0`，因此本报告只对**启动阶段**下结论；首帧与画质相关的结论需在重新授权后补测（与既有 R7 阻塞项同源）。

---

## 12. 实施记录（P1 + P2）

### 12.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| S1 透传 `pickCode` | `apps/web/app/api/library/play/[episodeId]/route.ts` + `features/player/play-stream-url.ts` | `streamUrl` / `proxyUrl` 追加 `&pickCode=`；缺失时保持原样，不影响非 115 驱动。URL 构造抽成纯函数以便单测 |
| S1 补齐 `pickCode` 来源 | `storage-115-executor.ts`（`Pan115Item.pick_code`）、`drive-file-manager.ts`（映射透传）、`drive-file-manager-types.ts`（`DriveFileItem.pickCode`） | **关键缺口**：原实现把 115 目录列举返回的 `pick_code` 丢弃，扫描入库恒为 `null`，透传优化在生产永远不会生效。修复后三个播放入口（库播放 / 文件夹视图 / 存储预览）都能带上 |
| P2 播放状态机 | `apps/web/features/player/playback-state-machine.ts` | 10 个阶段 + 显式迁移表；非法迁移只计数不抛错；输出各阶段首次进入偏移（分段耗时） |
| P2 遥测采样 | `apps/web/features/player/player-telemetry.ts` | 缓冲裕量/跨度/增速、`readyState`、`networkState`、丢帧比例；区间上限 8 段，非法值过滤 |
| P2 播放统计 HUD | `apps/web/features/player/components/player-telemetry-hud.tsx` | 三档（关闭 / 精简 / 详细），挂在 ArtPlayer `setting` 面板；关闭时无定时器、无监听 |
| P2 分段文案 | `mediary-player-core.tsx` + `library-item-modal.tsx` | 解析直链（按钮）→ 连接 CDN → 读取元数据 → 播放中；不再只有 8 s 单点兜底 |

单测：`playback-state-machine.test.ts`（11 例）、`player-telemetry.test.ts`（12 例），与既有 `player-viewport` / `player-shortcuts` / `audio-gain` 合计 45 例全部通过。

### 12.2 评估后**未**采纳

| 项 | 原因 |
| :--- | :--- |
| S3 移除 `Connection: close` | 115 对复用长连接存在 stale socket reset，`pan115-qrcode-login.test.ts` 已有同源先例与断言。首播延迟改由「透传 pickCode 减少一次 API 调用」消除，不用连接复用换稳定性 |

### 12.3 待办（P3 及补充）

1. **Range 共享池**：合并播放器并发探测请求，参考脚本 `shared-range-pool.ts` 已给出完整范式（在途共享、缓存命中、按用途归因）。
2. **首部优先预取**：非 faststart MP4 的 `moov` 在尾部，需显式补一次尾部 Range。
3. **预热策略中心**：进入详情面板时 `HEAD` 预热一次直链，必须复用 115 漏桶，禁止绕过限速。
4. **存量数据回填**：映射修复只对**新扫描**生效；已入库单集 `pick_code` 仍为 `null`，需一次重扫或补写脚本才能让存量条目享受提速。

### 12.4 验收口径

- 单元：状态机迁移、遥测采样边界（区间上限、非法值、增速回退）全部覆盖。
- 实机：`/api/strm/play` 首字节应显著下降（本机无 115 有效凭据时，收益体现在少一次 API 调用）；HUD 三档切换不产生控制台错误；关闭 HUD 后无定时器残留。

### 12.5 实机验收结果（开发实例 3020）

| 检查项 | 实测 | 结论 |
| :--- | :--- | :--- |
| 分段文案 | 点击后依次出现「正在连接网盘 CDN…」→「正在读取视频元数据…」 | 通过 |
| 生命周期属性 | `data-playback-phase="buffering"` | 通过 |
| HUD 详细档 | 进度 / 缓冲+增速 / 就绪+网络 / 缓冲区间 / 画面+丢帧 / 阶段 / 投送，7 行齐全 | 通过 |
| HUD 精简档 | 仅 2 行（进度、缓冲+增速） | 通过 |
| HUD 关闭档 | 浮层从 DOM 移除，无定时器残留 | 通过 |
| 控制台 | pageerror 0 / console error 0 | 通过 |
| 五页巡检 + R3–R6 回归 | `pagesOk / playerOk / memoryOk` 全 true | 通过 |
| 控制条几何 | wrapper / controls / video 底部均 864，`object-fit: contain` | 通过 |
| 快捷键与提示条偏好 | ESC 两段式、Space/F/?、三档偏好均正常 | 通过 |

**未能在本机量化的一项**：`/api/strm/play` 首字节仍在 2.0–4.5 s 区间，与改动前同量级。原因是该测试库单集 `pick_code` 为 `null`（已通过 `/api/library/play` 响应核实），且 115 Open OAuth 处于 `refresh_token` 失效状态——两条最优路径都不可用。`pickCode` 的收益需在**重新授权并重扫**后以 `T_first_frame` 复测；契约正确性已由 `play-stream-url.test.ts`（4 例）与 `readPickCode`（3 例）覆盖。
