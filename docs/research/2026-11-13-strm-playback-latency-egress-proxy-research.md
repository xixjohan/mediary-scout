# STRM 播放跳转慢的根因：出站代理白名单漏配 + Plex 强制代理投送

> 调研日期：2026-11-13
> 现象：Plex 播放 `.strm` 时首字节慢（2–7 秒），拖拽/seek 卡顿
> 样例链路：`Plex (`<PLEX_HOST>:32400`) → .strm → /api/strm/play/... → 115 CDN`
> 代码基线：`fcea5e7a`（生产 `v2026.11.13.3`）

---

## 1. 结论

慢的不是"跳转"，而是**每一条播放请求都要在我们的服务端重新建连并中转**，且这条中转链路被**错误地送进了外网代理**。三个原因按影响排序：

| # | 原因 | 影响 |
| :-- | :--- | :--- |
| **R1** | `NO_PROXY` 白名单只有 `115cdn.com`，而 115 实际下发的 CDN 域名是 **`*.115cdn.net`** → 视频流全部走 `HTTP_PROXY`（`<PROXY_HOST>:2080`）中转 | 首字节从 **0.25s** 劣化到 **2–7.5s**（实测） |
| **R2** | `isUserAgentProneToRedirectFailure()` 把 **Plex** 归为高危 UA，`delivery=redirect` 被强制改判为 `proxy` → Plex 的每个 Range 请求都由 Node 中转，无法直连 CDN | 每个 seek/分段都要重新经过服务端；无法利用 CDN 的就近节点 |
| **R3** | 115 解析在 OAuth 失效时**先打一次 Open API 再降级 Cookie**，Cookie 客户端还被 `withBrandPacing` 节流（≈1.2s/次） | 缓存未命中时，解析本身再叠加 1–2.4s |

本质：**把"签名直链"当成了必须服务端中继的资源，而网络出口策略又与业务域名白名单脱节。**

---

## 2. 实测数据（可复现）

在同一台宿主机的 `mediary-dev` 容器内测得：

| 路径 | 首字节 TTFB | 说明 |
| :--- | :--- | :--- |
| 容器内**直连** CDN（`https.request`，不走代理） | **214 / 257 / 570 ms** | CDN 本身很快 |
| 经 `/api/strm/play`（proxy 投送，含解析 + 代理中转） | **2270 / 3500 / 7468 ms** | 慢 8–30 倍 |
| 生产实例（网盘冻结态） | 403 / 13 ms | 冻结时快速失败（另一话题） |

关键对照：直连与经我们中转的**唯一差别**是出口是否经过 `<PROXY_HOST>:2080`。

### 2.1 复现命令

```bash
# 1) 容器内直连 CDN（脚本先向本机 API 取 Location，再 https.request，不走代理）
docker cp cdn-direct.mjs mediary-dev:/tmp/ && docker exec mediary-dev node /tmp/cdn-direct.mjs
# → {"status":206,"ttfbMs":257} ...

# 2) 经我们的播放端点（Plex UA 会被强制 proxy）
curl -s -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer}s\n' \
  -A 'PlexMediaServer/1.40.0.0' \
  'http://<host>:3020/api/strm/play/<storageId>/<fileId>?name=t.mp4'
# → code=200 ttfb=2.27~7.47s   （200 而非 302：说明走的是代理流）

# 3) 确认白名单缺口
docker exec mediary-dev printenv NO_PROXY
# → ...,115.com,.115.com,115cdn.com,.115cdn.com,anxia.com,...   ← 没有 115cdn.net
```

---

## 3. 代码级根因

### R1：代理白名单漏了 `115cdn.net`

- `apps/web/features/settings-system/core/http-proxy.ts:113-129` 的 `DEFAULT_DOMESTIC_NO_PROXY` 只列了 `115cdn.com` / `*.115cdn.com` / `.115cdn.com`；
- 而 115 实际签发的下载域名是 **`cdn*.115cdn.net`**（实测 `cdnfhnfile.115cdn.net`）；
- `CidrAwareProxyDispatcher` 按该名单逐 host 决策，未命中即走代理 → 视频流被送进外网代理。

**为什么"以前能用"**：代理是 opt-in（只有设置了 `HTTP_PROXY` 才安装 dispatcher）。这台宿主机为了 TMDB 加速开了代理，白名单没覆盖 `.net` 域名，于是"加速元数据"的开关顺手把"视频流"也拖慢了。

### R2：Plex 被强制判为 proxy

- `packages/workflow/src/strm/strm-delivery.ts:33-44`：`category === "plex"` → `isUserAgentProneToRedirectFailure = true`；
- `strm-delivery.ts:78-86`：115 在 `auto` 模式下**一律 proxy**；即便显式 `redirect`，命中高危 UA 也会被改判 proxy；
- 结果：`?delivery=redirect` 对 Plex 无效（实测仍返回 200 流）。

设计初衷可以理解（115 直链绑定 UA 签名，Plex 的后续 Range 请求可能 403），但它把**每一条** Range 都变成服务端中转，代价是：连接建立 × N + 出口带宽受限于服务器。

### R3：解析慢路径

- `packages/workflow/src/storage/stream-resolver.ts:120-145`：先试 Open API，`catch` 后 `console.warn` 再降级 Cookie；
- Cookie 客户端被 `withBrandPacing(..., "pan115")` 包裹（同文件 152-165 行），115 的节流约 1.2s/次；
- OAuth 失效时（当前状态），每次**缓存未命中**都要先付一次失败往返，再付 1.2s×N 的节流。

### 附带观察

- 302 响应带 `Cache-Control: no-store`（`route.ts:61-72`）：redirect 模式下客户端**无法缓存跳转**，每次都要回到我们这里。proxy 模式不受此影响，但会把流量压在服务器上。
- 代理转发本身是流式的（`new Response(upstreamResp.body)`），没有整段缓冲，所以吞吐不是瓶颈，**瓶颈是建连与出口路径**。

---

## 4. 方案

### P0：修白名单（最高收益，改 3 行）

1. `DEFAULT_DOMESTIC_NO_PROXY` 补 `115cdn.net` / `*.115cdn.net` / `.115cdn.net`；
2. 同步检查其它已支持网盘的 CDN 域名（`anxia.com`、`quark.cn` 已覆盖；123pan/189 建议一并核对）；
3. **更稳的做法**：解析出直链后，把 `new URL(url).hostname` 的注册域**动态并入** `NO_PROXY`（一次写入、进程内生效），这样下次 115 换 CDN 域名不会再踩。

预期：直连路径回到 0.2–0.6s，代理中转消失。

### P1：让 Plex 能走 redirect（可选，收益大但需验证）

| 方案 | 做法 | 风险 |
| :--- | :--- | :--- |
| A. 放开 Plex | 从高危列表移除 `plex`，改为"首字节探测失败再降级 proxy" | 若 115 拒绝 Plex 的 Range → 播放失败，需要自动回退 |
| B. 保留 proxy 但优化链路 | 保持中转，仅修 R1 + 连接复用 | 服务器带宽仍是上限 |
| C. 混合 | 前 N 秒走 proxy 探活，成功后 302 | 实现复杂，收益不确定 |

建议先做 A 的**灰度版**：对 Plex 允许 redirect，并在客户端/服务端加"302 后 403 → 自动切 proxy"的降级（我们已有 `delivery=proxy` 的会话切换能力）。

### P2：解析快路径

- 记录 OAuth 的"已判定 fatal"状态（P1 冻结已具备），**fatal 时直接走 Cookie 分支**，省掉一次必然失败的 Open API 往返；
- 对同一 `fileId` 的并发 Range 请求，`SingleFlight` 已存在，确认缓存键在 proxy 模式下是 `proxy:shared`（是），不会因 UA 抖动而击穿。

### P3：预热与观测

- `.strm` 生成后或播放器打开时**预解析**一次直链并写缓存，把解析成本移出首播关键路径；
- 服务端补分段耗时日志（`resolve / upstream-connect / first-byte`），与播放器 HUD 的"解析直链 → 连接 CDN"对齐。

---

## 5. 设计模式落点

| 模式 | 落点 | 作用 |
| :--- | :--- | :--- |
| **策略 Strategy** | `DeliveryModePolicy`（现有责任链） | 把"高危 UA"从硬编码名单改为**可配置 + 可探测**（先试后降级） |
| **适配器 Adapter** | `EgressPolicyAdapter`：域名 → 直连/代理决策 | 白名单不再散落在 env 与常量两处 |
| **装饰器 Decorator** | `PacedResolver` 外层加 `FailFastOnFatal` | fatal 状态直接短路，不付失败往返 |
| **状态机 State** | 播放链路 `resolving → connecting → streaming → degraded` | 让"降级到 proxy"成为显式迁移，而不是 catch 里的一句 warn |

---

## 6. 业界对照

| 来源 | 做法 | 启示 |
| :--- | :--- | :--- |
| **Jellyfin / Plex 直连播放** | 优先 Direct Play（客户端直连源站），仅在容器不兼容时转码/中转 | 中转是兜底，不是默认 |
| **Node undici `ProxyAgent`** | 只认显式 dispatcher；`NO_PROXY` 需应用层自行实现 | 我们已实现 `CidrAwareProxyDispatcher`，但**名单必须覆盖真实 CDN 域名** |
| **CDN 直连实践** | 白名单按"注册域"而非"单个主机"维护，且随供应商变更同步 | 建议按 `.115cdn.net` 这类后缀维护，并加门禁 |
| **Radarr/Sonarr 的下载客户端** | 直链交给下载器，服务端不参与数据面 | 数据面越少经过服务端，越稳定 |

---

## 7. 可复用资产

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| `DEFAULT_DOMESTIC_NO_PROXY` | `features/settings-system/core/http-proxy.ts:113` | P0 直接补域名 |
| `CidrAwareProxyDispatcher` | 同文件 | 支持 CIDR 与后缀匹配，动态追加即可生效 |
| `isUserAgentProneToRedirectFailure` | `strm/strm-delivery.ts:33` | P1 的改造点 |
| `delivery-mode-resolver` | `strm/delivery-mode-resolver.ts` | 已有责任链（session > binding > library > global > driver） |
| `strm_link_cache` + `SingleFlight` | `persistence` + `strm/single-flight.ts` | 缓存与并发去重已就绪 |
| 播放器 HUD 分段耗时 | `features/player` | 客户端侧已有"解析直链/连接 CDN"计时，可与服务端日志对齐 |

---

## 8. 门禁与回归测试（防复发）

### 8.1 静态门禁（硬阻断）

```
断言 DEFAULT_DOMESTIC_NO_PROXY 必须包含：
  .115cdn.net / .115cdn.com / .anxia.com / .quark.cn / .uc.cn
并断言「新增网盘驱动时，其 CDN 注册域必须出现在该名单」
（以驱动清单驱动，避免漏配）
```

这条门禁的价值：本次故障的根因就是"名单与真实域名不同步"，纯人工审查很难发现。

### 8.2 单元测试

```
- 给定 host=cdnfhnfile.115cdn.net → shouldProxy(host) === false
- 给定 host=api.themoviedb.org      → shouldProxy(host) === true
- 给定 host=115cdn.com              → false（回归保护）
```

### 8.3 集成/验收（可脚本化）

```
容器内：解析一条真实直链 → 分别用「默认 dispatcher」与「直连」请求 Range 0-1023
断言：两者 TTFB 差值 < 300ms（当前实测差值 2000~7200ms）
```

### 8.4 观测门禁

`/api/strm/play` 增加结构化日志：`{ fileId, delivery, cacheHit, resolveMs, upstreamMs, status }`。
若 `resolveMs + upstreamMs > 1500ms` 连续出现，视为性能回归信号。

---

## 9. 风险

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 放开 Plex redirect 后 403 | 115 对 UA 签名敏感 | 保留"403 → 自动切 proxy 并记住"的会话级降级 |
| 动态追加 NO_PROXY | 进程内全局 dispatcher 变更会影响其它请求 | 只追加域名、不删除；变更后打日志 |
| 冻结态 403 | 当前网盘冻结时 STRM 直接 403（`resolveTaskConfig` 判 `isActive`） | 属预期；重新授权后自动恢复 |
| 代理仍被用于 TMDB | 元数据确实需要代理 | 白名单只加国内 CDN，不影响外网加速 |

---

## 10. 一句话总结

**慢的根源不在"跳转"，而在"每条播放请求都被迫经过服务端，而这条出口又绕进了外网代理"**——修好 `NO_PROXY` 的 `.115cdn.net` 缺口，再让 Plex 有机会走直连，首字节可从 2–7 秒回到 0.2–0.6 秒。

---

## 11. 实施记录与实测效果（P0 + P2 + P3，P1 以开关形式落地）

### 11.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| P0 白名单补域 | `features/settings-system/core/http-proxy.ts` | `DEFAULT_DOMESTIC_NO_PROXY` 增加 `115cdn.net` / `*.115cdn.net` / `.115cdn.net` |
| P0 判定增强 | 同文件 `CidrAwareProxyDispatcher.dispatch` | 原来只按 **CIDR** 判定（`matchesNoProxyCidr` 对主机名直接返回 false，域名条目实际依赖 `EnvHttpProxyAgent` 内部快照）；现同时按主机名后缀判定，使运行期补入的域名即时生效 |
| P0 动态补白 | `packages/workflow/src/storage/egress-no-proxy.ts` + `stream-resolver.ts` | 解析出直链后取可注册域自动追加到 `NO_PROXY`（只增不删、幂等） |
| P2 解析快路径 | `packages/workflow/src/storage/open-api-circuit.ts` + `stream-resolver.ts` | OAuth 致命失效（`40140137/40140116`）后 30 分钟内直接走 Cookie，跳过必然失败的 Open API 往返 |
| P1 灰度开关 | `strm/strm-delivery.ts` | 强制代理 UA 类别支持 `STRM_FORCE_PROXY_UA_CATEGORIES` 覆盖；**默认值不变**（仍含 plex），需要时再放开 |
| P3 观测 | `api/strm/play/[taskId]/[fileId]/route.ts` | 输出 `{"delivery","cacheHit","resolveMs"}` 与 `{"phase":"upstream","upstreamMs","status"}` 结构化日志 |

### 11.2 实测效果（开发实例，同一 CDN 直链）

| 指标 | 修复前 | 修复后 |
| :--- | :--- | :--- |
| `/api/strm/play` 首字节（Plex UA，proxy 投送） | **2.27 / 3.50 / 7.47 s** | **0.19 / 0.19 / 0.26 s** |
| 容器内 `EnvHttpProxyAgent` 取 Range 0-1023 | 2823 / 3813 / 420 ms | 246 / 284 / 175 ms |
| 容器内直连（基线） | 232 / 216 / 83 ms | 同左（未变） |

即：**代理中转被消除后，服务端代理投送的首字节已接近直连基线**。

日志实测：`[strm-play] {"phase":"upstream","upstreamMs":181,"status":206}` —— 上游首字节稳定在 ~180–240ms。

### 11.3 门禁

`apps/web/features/settings-system/core/no-proxy-coverage.test.ts`：

1. 按「驱动 → CDN 域名」清单逐个断言必须直连（115cdn.net / 115cdn.com / quark.cn / uc.cn / 123pan.com / alipan.com）；
2. 断言外网域名（themoviedb.org、github.com）不得被误放行。

配套单测：`egress-no-proxy.test.ts`（可注册域、后缀匹配、幂等追加）、`open-api-circuit.test.ts`（熔断/到期/隔离/解除）。

### 11.4 未做与遗留

| 项 | 说明 |
| :--- | :--- |
| P1 真正放开 Plex 直连 | 只提供了开关，默认仍强制 proxy。放开前需验证 Plex 对 115 签名的 Range 请求是否 403，建议先在单条任务上灰度 |
| P3 预解析 | 未做；当前解析已走缓存 + 熔断，收益小于改动面 |
| 播放器控制条 53px 偏移 | 验收中发现 `.art-controls` 位于 `.art-bottom`（高度 828）之外（top 871，超出 864 共 53px，被 `overflow:hidden` 裁切）。本轮改动未触及播放器与 CSS，且与字幕开关无关，判定为**独立遗留缺陷**，需单独排查 |
