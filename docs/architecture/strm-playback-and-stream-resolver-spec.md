# STRM 播放直链解析与流媒体中继架构设计规范

## 1. 问题背景与故障定位

### 1.1 用户故障现象
用户反馈 STRM 任务生成的串流中继链接无法在主流媒体播放器（Infuse、Apple TV、PotPlayer、Emby 等）中正常播放：
```text
http://127.0.0.1:3001/api/strm/play/cs_3204551/3551693272365663529?name=%E3%83%89%E3%83%A9%E3%82%B4%E3%83%B3%E3%83%9C%E3%83%BC%E3%83%AB%E8%B6%85%EF%BC%88%E3%82%B9%E3%83%BC%E3%83%91%E3%83%BC%EF%BC%89%20-%20S01E01%20-%20%E7%AC%AC%201%20%E9%9B%86.mkv
```
目标文件为《龙珠超：比鲁斯》第 1 集（7.42 GB 高清 MKV 视频，115 提取码 `cs3a89o5pq02qdbx4`）。

### 1.2 三重致命阻断根因分析
经过全链路抓包与逆向排查，确认导致播放彻底瘫痪的三重连锁根因：

1. **根因一：交互式鉴权误伤外部媒体播放器（401 Unauthorized）**
   * `/api/strm/play/[storageId]/[fileId]/route.ts` 首行无差别调用 `requireApiAccount(request)`。
   * 当系统设置了站长密码或启用多用户时，Infuse / PotPlayer / Apple TV 通过本地 `.strm` 文件发起取流请求，媒体播放器绝不可能携带浏览器的 Web Session Cookie，直接被闸机拦截为 `401 Unauthorized`。

2. **根因二：生产运行时解析器仍为虚构假桩（Mock Storage Resolver）**
   * 系统此前未实现生产级网盘流媒体解析器，`stream-resolver.ts` 默认单例被初始化为 `MockStorageStreamResolver`。
   * 无论传入何种存储 ID，均返回假桩地址 `https://mock-cdn.cloudpan.com/download/...`，导致播放器或流式代理直接遭遇 DNS 无法解析或 SSL 握手阻断（`ERR_SSL_TLSV1_UNRECOGNIZED_NAME`）。

3. **根因三：115 普通 API 大文件硬阻断与 User-Agent 验签绑定（50028 & 403 Forbidden）**
   * **大文件限制**：普通接口 `https://webapi.115.com/files/download` 针对 >1GB/2GB 的大文件直接拒绝并报错 `50028: 文件大小超出限制，请使用115电脑端下载`。对于 7.42GB 的原盘影视必须采用 115 官方 Chrome/App 专用加密协议接口 `https://proapi.115.com/app/chrome/downurl?t=${tm}`。
   * **User-Agent 强签名绑定**：115 CDN 接口计算下载签名参数（`k`, `t`, `s`, `d`）时，会将请求 downurl 时的 `User-Agent` 与签名算法强绑定。若在申请直链时使用固定浏览器 UA，而外部播放器（如 `Infuse/7.7.1`）直连 CDN 时发送自身 UA，115 CDN 将直接返回 `403 {"message":"invalid signature"}`。

---

## 2. 业界主流方案调研与借鉴

对比业界主流网盘与 STRM 媒体服务实现：

| 对比维度 | AList | Litepan (Go) | p115client (Python) | Mediary Scout 架构决策 |
| :--- | :--- | :--- | :--- | :--- |
| **播放鉴权** | 开放游客直链或 Token 签名校验 | `authorizeSTRMPlay` 校验 Token/签名，不依赖 Cookie | CLI/内部调用 | **混合放行模式**：支持会话凭据；无 Cookie 播放器直连时，校验受信任活跃网盘并继承账号授权 |
| **115 取流协议** | 接入 115 App/Chrome 加密协议 | 驱动层提取 PickCode | 实现 115 混淆加解密与 RSA 模幂 | **完整内嵌 DownURL Cipher**：实现对称 XOR + 动态密钥置换 + RSA 大数模幂 |
| **重定向标头** | 基础 302 | 标准 4 反缓存标头（含 `Referrer-Policy: no-referrer`） | 依赖 upstream | **对齐 Litepan**：完整输出 `Cache-Control`, `Pragma`, `Expires`, `Referrer-Policy` |
| **UA 协同策略** | 请求头透传或重定向防盗链 | 透传播放器 UA 至直链缓存 | 固定 Android/Chrome UA | **全链路 UA 协同**：提取播放器 UA 向 115 申请专属验签直链，LinkCache 按 storage+file+UA 隔离 |
| **防击穿防护** | 内存 TTL 缓存 | SingleFlight 请求合并 | 无 | **双保险**：SingleFlight 协程合并 + SQLite TTL Link Cache 防播放器 Range 探测风暴 |

---

## 3. 核心架构设计与工程实现

### 3.1 115 Chrome/App 协议密码学实现 (`pan115-downurl-cipher.ts`)
115 电脑端大文件取流接口通过双层加密协议防篡改：
1. **客户端请求加密 (`encode115DownurlPayload`)**：
   * 将明文 JSON（`{"pickcode":"..."}`）通过 MD5 时间戳派生动态 Key1；
   * 进行 4 字节/12 字节对称混淆转置（`m115SymEncode`）；
   * 前插 16 字节 Key1 后，使用 115 官方 RSA 1024-bit 公钥（`RSA_E = 0x10001`, `RSA_N`）以分块模幂加密（PKCS#1 v1.5 padding），最终 Base64 编码提交。
2. **服务端密文响应解密 (`decode115DownurlResponse`)**：
   * 服务端私钥加密响应，客户端使用公钥执行 RSA 模幂解密（`modPow(chunk, RSA_E, RSA_N)`）；
   * 剥离 PKCS#1 头部获取 16 字节服务端动态 Key2 与混淆密文；
   * 调用 `m115SymDecode` 完成反向解密并还原 UTF-8 JSON，成功提取无大小限制的官方 CDN 直链。

### 3.2 生产级流媒体解析器 (`ProductionStorageStreamResolver`)
位于 `packages/workflow/src/storage/stream-resolver.ts`：
* **存储路由**：根据 `storageId` 动态查询当前系统绑定的活跃网盘及解密凭据；
* **凭据与状态守卫**：存储未绑定报错 `STORAGE_NOT_FOUND`；存储被冻结报错 `STORAGE_FROZEN`；
* **单例客户端缓存**：按 `storageId` 维护 `Pan115CookieClient` 实例，复用连接池；
* **动态 PickCode 解析**：支持直接传入 `pickCode`，若未提供则调用 `/files/file` 自动依据 `fileId` 查询解析；
* **双模支持**：支持 `redirect`（302 重定向直连）与 `proxy`（HTTP 206 服务器中继分片）。

### 3.3 媒体播放器兼容鉴权与反缓存标头 (`route.ts`)
位于 `apps/web/app/api/strm/play/[storageId]/[fileId]/route.ts`：
```typescript
// 1. 无 Cookie 播放器直连：校验 storageId 是否对应系统中已绑定且活跃的网盘存储
if (!accountId) {
  const storage = await repo.getConnectedStorageById(storageId);
  if (!storage) return NextResponse.json({ error: "未授权或未找到网盘存储" }, { status: 401 });
  if (storage.status !== "active") return NextResponse.json({ error: "网盘存储非 active 状态" }, { status: 403 });
  accountId = storage.accountId || "acct_default";
}

// 2. 302 Found 反缓存与防盗链标头
function handleRedirect(targetUrl: string): Response {
  return NextResponse.redirect(targetUrl, {
    status: 302,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Referrer-Policy": "no-referrer",
    },
  });
}
```

---

## 4. 质量门禁与端到端实测验证

### 4.1 质量门禁 (`tools/gates/check-strm-playback.mjs`)
集成至 `package.json` 的 `npm run gate:strm` 与 `npm run gate` 流水线中，包含 5 项断言：
1. `stream-resolver.ts` 必须具备 `ProductionStorageStreamResolver` 并集成真实网盘驱动；
2. `runtime-container.ts` 必须实现 `ensureStorageStreamResolver` 运行时动态注入；
3. `pan115-downurl-cipher.ts` 必须完备导出编解码加解密函数；
4. `pan115-cookie-client.ts` 必须优先接入 `proapi.115.com/app/chrome/downurl` 绕过大文件硬限制；
5. `route.ts` 严禁直接使用交互式 `requireApiAccount` 强阻断，必须实现 4 项反缓存标头与代理容错。

### 4.2 真实端到端串流取流实测结果
使用真实凭据与文件 ID `3551693272365663529`（7.42GB 《龙珠超：比鲁斯》第 1 集）实测：

```text
=== 测试 1: 真实 302 重定向取流与 CDN 直连播放 ===
302 响应状态码: 302
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Expires: 0
Referrer-Policy: no-referrer
Location: https://cdnfhnfile.115cdn.net/60784e56b2775d6ddb014e4e71ee404818aed94f/...

正在对 115 CDN 直链发起 Range(bytes=0-99) 分片请求 (使用 Infuse UA)...
CDN 响应码: 206 Partial Content
CDN Content-Range: bytes 0-99/7421489033
CDN 视频首部魔数 (Hex): 1a45dfa3
✅ 验证成功: 真实 115 CDN 成功吐出 Matroska (MKV) 视频首部！

=== 测试 2: 串流代理模式 (mode=proxy) 与 HTTP 206 Range 分片转发 ===
Proxy 响应状态码: 206 Partial Content
Proxy Content-Range: bytes 0-99/7421489033
Proxy Content-Type: application/octet-stream
Proxy 视频首部魔数 (Hex): 1a45dfa3
✅ 验证成功: 串流代理模式成功透传 HTTP 206 分片与 MKV 视频内容！

🎉 全部真实串流播放端到端验证通过！
```
