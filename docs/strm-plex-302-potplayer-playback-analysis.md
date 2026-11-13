# 深入排障与方案：STRM �?Plex 302/301 重定向后 PotPlayer 无法播放的根因剖析与架构解决方案

> **文档标识**：`docs/strm-plex-302-potplayer-playback-analysis.md`  
> **涉及组件**：Plex Media Server、STRM 模块�?15 网盘驱动、StorageStreamResolver、PotPlayer、HTTP 协议�? 
> **凭据安全规范**：本文档严格遵循安全规范，所�?IP、Token、Cookie 及敏感路径均采用 RFC 5737 虚拟占位符（�?`192.168.1.60`、`TOKEN_REDACTED`）�?
---

## 1. 现象复盘与全链路时序�?
### 1.1 触发场景
用户�?PotPlayer 中打开 Plex 的媒�?Part 地址（或�?Plex 客户端选择通过外部播放�?PotPlayer 串流）：
```http
http://192.168.1.60:32400/library/parts/176457/1794396015/file?X-Plex-Token=TOKEN_REDACTED
```
该媒体在 Plex 库中实际�?Mediary Scout 生成�?`.strm` 虚拟指针文件挂载，STRM 文件内记录了 Mediary 的播放中�?URL�?```http
http://192.168.1.100:3000/api/strm/play/strm_task_demo/3559788337009002016?name=demo.mkv&token=demo_token&exp=1825932015
```
**现象**：PotPlayer 无法打开播放该流，提示“无法播放该文件”或静默闪退�?
---

### 1.2 全链路抓包时序与实际响应分析

通过对生产链路执行逐跳探针与追踪诊断，全链�?HTTP 交互行为如下�?
```mermaid
sequenceDiagram
    autonumber
    participant PotPlayer as PotPlayer (客户�?
    participant Plex as Plex Media Server (192.168.1.60)
    participant Mediary as Mediary Scout (192.168.1.100)
    participant CDN115 as 115 官方 CDN (AliyunOSS)

    PotPlayer->>Plex: 1. GET /library/parts/.../file?X-Plex-Token=... (UA: PotPlayer)
    Note over Plex: 识别�?Part �?.strm 虚拟指针文件
    Plex-->>PotPlayer: 2. HTTP 301 Moved Permanently<br/>Location: http://192.168.1.100:3000/api/strm/play/...

    PotPlayer->>Mediary: 3. 跟随 301: GET /api/strm/play/... (UA: PotPlayer)
    Note over Mediary: 命中 strm_link_cache 缓存 (命中此前 Chrome 生成的直�?
    Mediary-->>PotPlayer: 4. HTTP 302 Found<br/>Location: https://cdnfhnfile.115cdn.net/...?t=...&k=...

    PotPlayer->>CDN115: 5. 跟随 302: GET https://cdnfhnfile.115cdn.net/... (UA: PotPlayer)
    Note over CDN115: 校验签名 (参数 k 是基�?Chrome UA 签名加密计算�?
    CDN115-->>PotPlayer: 6. HTTP 403 Forbidden<br/>{"message": "invalid signature", "status": 403}
```

---

## 2. 根因深度剖析 (The Root Causes)

经抓包实测与代码深度审计，该问题是由 **三大技术冲突共同作用引发的链式阻断**�?
### 核心根因 1�?15 CDN 直链强绑�?User-Agent 签名，Mediary 缓存缺乏 UA 维度引发“UA 污染�?
- **115 的直链签名防盗链机制**�?  115 网盘在调用直链解析接口（�?`proapi.115.com/app/chrome/downurl` 或开放平�?API）生成下载直链时，将请求方携带的 `User-Agent` 与时间戳深度参与了加密哈希运算，并将签名注入 URL �?`k` 等鉴权参数中�?  **115 CDN（阿里云 OSS 节点）在接收下载请求时，会严格比�?HTTP 请求头中�?`User-Agent` �?URL 中的数字签名。一旦两者不完全一致，立即拒绝并返�?HTTP 403 `{"message": "invalid signature"}`�?*
- **Mediary Scout 的缓存设计漏�?*�?  �?`apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts` 中：
  ```typescript
  const cacheKey = `${storageId}:${fileId}`;
  const cached = await repo.getStrmLinkCache(cacheKey);
  if (cached && !cached.downloadUrl.includes("mock-cdn.cloudpan.com")) {
    return serveStream(request, cached.downloadUrl, ...);
  }
  ```
  `cacheKey` 仅由 `storageId` �?`fileId` 组成�?*完全缺失�?User-Agent 维度**�?- **实证复现**�?  通过直接查询生产数据�?`strm_link_cache` 证实：该直链在数据库中保存的记录为：
  ```json
  {
    "cache_key": "cs_demo:3559788337009002016",
    "delivery_mode": "redirect",
    "headers_json": "{\"User-Agent\":\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\"}"
  }
  ```
  该直链是此前由桌�?Chrome 浏览器访问触发生成的�?  �?PotPlayer 请求该直链时，Mediary 直接将给 Chrome 生成的直链以 302 丢给 PotPlayer。PotPlayer 带着自己�?`PotPlayer` UA 去请�?115 CDN，触�?115 签名不匹配，确定性返�?**403 Forbidden**�?- **对照实验验证**�?  - 使用 PotPlayer 或普�?curl UA 请求该直链：返回 `403 Forbidden` (`{"message": "invalid signature"}`)�?  - 使用该直链生成时绑定�?Chrome UA 请求该直链：立即返回 **`HTTP/1.1 200 OK`，`Content-Length: 1671459959` (1.55GB)**，视频流完好无损�?
---

### 核心根因 2：HTTP 302 重定向协议无法强制客户端携带特定的上游请求头

- �?`deliveryMode = "redirect"` 模式下，Mediary 服务端返回的是标�?`HTTP 302 Found` �?`Location: <url>`�?- **HTTP 规范约束**�?02 重定向只能控制下一跳的 URL�?*完全无法控制客户端在下一跳请求时使用�?Header（如 User-Agent、Referer 等）**�?- 客户端在重定向至 115 CDN 时，必然使用客户端自身的网络引擎 UA（PotPlayer 使用其内置网络库 UA）。服务端即便在数据库或响应头中记录了正确�?UA，也无法注入�?PotPlayer 的下一跳请求中�?
---

### 核心根因 3：媒体响应头阻断（`Content-Disposition: attachment` �?`application/octet-stream`�?
115 CDN 直链对于视频文件的默�?HTTP 响应头为�?```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Disposition: attachment
Accept-Ranges: bytes
```
- `Content-Disposition: attachment`：显式告知客户端这是一个“下载附件”，而非可内联播放的流媒体�?- `Content-Type: application/octet-stream`：通用二进制流，缺失具体媒�?MIME 类型（如 `video/x-matroska` �?`video/mp4`）�?- 绝大多数播放器在跟随连续 301/302 重定向后，遇�?`attachment` 头部时，解码管线无法被正确激活，导致无法识别为音视频媒体流�?
---

### 次要影响因素 4：Windows SChannel TLS 证书链检查与双重重定�?
- �?Windows 原生网络环境（PotPlayer 使用�?Windows 系统网络栈）下，直接访问 `https://cdnfhnfile.115cdn.net/` 时，若未禁用 CRL/OCSP 吊销检查，由于部分国内 CDN �?OCSP 响应延迟或被防火墙拦截，系统�?TLS 握手会直接抛出：
  `schannel: failed to receive handshake, SSL/TLS connection failed (curl 35)`
- 连续两次重定向（`Plex 301 -> Mediary 302 -> 115 HTTPS`）在跨协议（HTTP �?HTTPS）与多级跳转过程中，部分旧版播放器可能会丢失 Range 头或导致连接断开�?
---

## 3. 业界主流开源方案调研与横向对比

针对“网�?302 直链 + 第三方播放器（PotPlayer/Infuse/VLC�? Plex/Emby”生态中�?UA 签名失效与播放阻断问题，业界主流项目的解决策略如下：

| 方案 / 项目 | 架构设计原理 | 优势 | 局限性与代价 | 对本项目的借鉴价�?|
| :--- | :--- | :--- | :--- | :--- |
| **AList / OpenList**<br>`多维缓存�?302 直推` | 1. 客户端请求携�?UA �?AList<br>2. AList 用该客户�?UA 向网盘申请直�?br>3. `CacheKey = FileId + MD5(UA) + IP`<br>4. 302 重定向至 CDN | 零服务器带宽消耗；支持大部分原生透传 UA 的客户端 | 若播放器�?302 下一跳擅自修�?UA（如从浏览器弹出�?PotPlayer），依然会报 403；对不同设备无法复用缓存 | **必须借鉴**：STRM 缓存设计必须引入 User-Agent 隔离维度，禁止全局串味 |
| **plex2Alist / emby2Alist**<br>`Nginx 智能反向代理网关` | �?Plex/Emby 前挂�?Nginx/Lua�?br>1. 拦截播放请求<br>2. 识别客户端特�?br>3. 遇到 115/强防盗链时，**自动切换�?Proxy 反向代理**，重�?Content-Type �?Disposition | 播放成功�?100%；彻底解决跨域、UA 错位、SChannel 握手�?attachment 弹窗 | 消耗反代服务器的上�?下行网络带宽 | **必须借鉴**：在防盗链网盘场景下，系统必须具备透明无缝回退�?Proxy 串流中继的能�?|
| **M3U / URL 伪协议注�?*<br>`#EXTVLCOPT / dpl` | 在生成播放列表时，注入播放器专有指令�?br>例如 `#EXTVLCOPT:http-user-agent=...` �?PotPlayer 参数文件 | 强制播放器带上指�?UA 发起网络连接 | 仅极少数播放器（VLC、Kodi）支持扩展头�?*Plex 原生完全不支持该机制**；STRM 文件规范不支持自定义�?| 不适合 Plex + STRM 架构 |
| **Mediary Scout 串流代理**<br>`(In-House Proxy Pipeline)` | 服务端作�?HTTP 206 Partial Content 流式中继�?br>1. 服务端使用合规固�?UA �?115 获取直链<br>2. 服务端带合规 UA �?115 拉流<br>3. 流式管道吐给客户端，重写 inline �?video MIME | 彻底脱敏客户端差异，零配置、零 403、跨平台播放�?100% 顺畅起播 | 占用服务端流�?| **本项目核心方�?*：当前系统已经原生内置该流式代理基础设施，仅需调整路由调度 |

---

## 4. 当前系统已有基础设施与可复用资产

当前 Mediary Scout 代码库中已经拥有完善的基础设施，具备即开即用的解决方案：

1. **高性能流媒体代理中继器 (`handleStreamProxy`)**�?   位于 `apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts`�?   - 原生支持 HTTP `Range` 头透传�?HTTP 206 Partial Content 分片�?   - 具备 `buildProxyResponseHeaders`，已内置�?     - `inferVideoMimeType(fileName, upstreamContentType)`：将 `application/octet-stream` 智能重写为标�?`video/mp4` �?`video/x-matroska`�?     - `content-disposition: inline; filename="..."`：将网盘�?`attachment` 强制矫正�?`inline`，避免播放器退化为下载模式�?     - `Accept-Ranges: bytes`：支持进度条任意拖拽 Seek�?     - CORS 跨域请求头全量开放�?   - 具备 `buildUpstreamHeaders`：自动将直链解析时存储的 `customHeaders`（含合规 `User-Agent`）作为上游请求头发送给 115�?2. **传输交付模式抽象 (`deliveryMode`)**�?   - 任务配置与数据库�?`strm_task_configs` 已经支持 `delivery_mode: "redirect" | "proxy"`�?   - `stream-resolver.ts` 支持输出 `deliveryMode`�?
---

## 5. 具体解决方案与改造规�?
为了兼顾�?*性能直连�? 服务器带宽）**”与�?*绝对兼容性（100% 播放成功�?*”，实施三层防御改造：

### 5.1 方案 A：修�?Cache Key，杜�?User-Agent 交叉污染 (P0)

�?`apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts` 中，修复缓存生成与查询算法：

```typescript
// 规范�?User-Agent，提取核心标识（�?Chrome/VidHub/PotPlayer），避免细微版本号导致缓存过度碎片化
function normalizeUserAgentKey(ua: string | null): string {
  if (!ua) return "default";
  if (ua.includes("PotPlayer")) return "potplayer";
  if (ua.includes("VidHub")) return "vidhub";
  if (ua.includes("Infuse")) return "infuse";
  if (ua.includes("MicroMessenger")) return "wechat";
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Chrome/")) return "chrome";
  return "other";
}

// 缓存键引�?UA 维度
const clientUa = request.headers.get("user-agent");
const uaCategory = normalizeUserAgentKey(clientUa);
const cacheKey = `${storageId}:${fileId}:${uaCategory}`;
```
**收益**：彻底消�?Chrome 浏览器与 PotPlayer、Infuse 等不同设备客户端之间的直链签名污染�?
---

### 5.2 方案 B：对 115 / 强鉴权存储驱动启用智能自适应代理 (Smart Adaptive Mode) (P0)

针对 115 等要�?UA 强一致性的网盘，在 `serveStream` 中加入智能客户端侦测�?
```typescript
function shouldForceProxyDelivery(request: NextRequest, configDeliveryMode: string): boolean {
  // 1. 若配置显式指�?proxy，直接走 proxy
  if (configDeliveryMode === "proxy") return true;

  // 2. 检测已知在 302 下容易丢失或篡改 UA 的播放器 (PotPlayer, MPV, VLC �?
  const ua = request.headers.get("user-agent") || "";
  const isProneToUaDrop =
    ua.includes("PotPlayer") ||
    ua.includes("libmpv") ||
    ua.includes("VLC") ||
    ua.includes("Lavf") || // FFmpeg
    !ua; // 缺失 UA

  return isProneToUaDrop;
}
```
**收益**�?- 当浏览器或支持良好直链签名的客户端访问时，继续享�?302 零带宽直连；
- 当检测到 PotPlayer、FFmpeg、Plex 内部探针时，自动切换�?`handleStreamProxy`，通过服务端管道以 HTTP 206 流式中继输出，重�?`inline` �?`video/x-matroska`，确�?PotPlayer 秒开播放�?
---

### 5.3 方案 C：STRM 任务配置支持设置 `deliveryMode` �?`proxy`

�?STRM 任务配置与编辑弹窗（`create-strm-task-modal.tsx` / `edit-strm-task-modal.tsx`）中，确保用户可�?115 网盘任务明确选择 **“串流代理模�?(Proxy)�?*。对于家庭千兆内网环境，服务器代理仅占用局域网内网带宽，可彻底消除公网 CDN 各种防盗链风控干扰�?
---

## 6. 自动化测试与防回归门禁规�?
为保证后续开发与重构不再破坏该播放链路，必须落地以下测试套件与门禁保障：

### 6.1 单元测试：Cache Key �?User-Agent 隔离性验�?- **测试用例**：`packages/workflow/src/strm/strm-cache-key.test.ts`
- **断言目标**�?  1. 使用 Chrome UA 请求生成的直链，不能被携�?PotPlayer UA 的后续请求命中�?  2. 相同客户端类别的后续请求必须能够平滑命中有效缓存，不引发重复直链解析请求�?
### 6.2 集成测试：串流代理模式头部规范化断言
- **测试用例**：`apps/web/app/api/strm/play/stream-play.test.ts`
- **断言目标**�?  1. 上游返回 `Content-Disposition: attachment` 时，`handleStreamProxy` 输出必须被强制更正为 `inline`�?  2. 上游返回 `application/octet-stream` 时，根据文件扩展名（�?`.mkv`）必须正确输�?`video/x-matroska`�?  3. 支持 `Range: bytes=0-1024` 分片请求，必须正确返�?HTTP 206 �?`Content-Range` 响应头�?
### 6.3 冒烟验收标准（实机回�?Checklist�?1. �?Plex 中打开任意基于 115 网盘�?STRM 媒体，复制其 Part 链接�?PotPlayer 中打开，视频需�?1 秒内开始播放�?2. 拖动 PotPlayer 进度条至 50% 处，必须能够精准 Seek 且不�?403 错误�?3. 同时�?Edge 浏览器、Chrome 浏览器及 PotPlayer 中打开同一 STRM 链接，三者均需正常播放，不得出现任何一方将另一方直链冲刷失效的情况�?
