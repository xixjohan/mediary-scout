# 115 Open OAuth「又过期」根因分析：旋转型凭据在多副本间的复用冲突

> 调研日期：2026-11-13
> 现象：`[token-keepalive] FATAL: 115 Open OAuth for cs_340802261 requires re-authorization`，`code=40140137 refresh_token 已失效`
> 代码基线：`f1a5efc8`
> 关联文档：`2026-11-13-strm-ttl-organize-and-multiversion-research.md`（直链过期自愈）

---

## 1. 结论

**与最近几次代码提交无关，但与「今天的部署频率 + 双实例共享同一 115 账号」强相关。**

根因链（逐环有证据）：

1. 115 开放平台的 `refresh_token` 是**旋转型一次性凭据**：每次刷新下发新值，旧值作废；复用旧值会触发失效（甚至整链吊销）。
2. 开发实例（`mediary-dev`）与生产实例（`mediary`）**绑定的是同一个 115 账号**（`provider_uid` 指纹一致）。
3. 两个实例各自持有**独立的 SQLite**，也就各自持有一份 `refresh_token` 副本。
4. 跨进程刷新租约（`pan115_oauth_refresh_leases`）**只在各自的库里生效**，跨实例完全无效。
5. 保活刷新阈值是"剩余有效期 ≤ 1 小时"，且"20 分钟最小间隔"存在**进程内存**里——容器每次重启即清零。今天开发实例部署了 10+ 次，**每次重启都可能触发一次旋转**，把生产实例手里的副本打成废票；生产侧用废票刷新 → `40140137`（致命）→ 停止重试并要求重新授权。

一句话本质：**把「旋转型一次性凭据」当成了「可复制的长期密钥」在多副本间共享。**

---

## 2. 证据

### 2.1 两个实例绑定同一账号，但凭据副本不同

| 检查项 | mediary-dev | mediary（生产） |
| :--- | :--- | :--- |
| storage id | `cs_340802261` | `cs_340802261` |
| provider | `pan115` | `pan115` |
| `provider_uid` SHA-256 前 12 位 | `7143b5c92345` | `7143b5c92345`（**同一账号**） |
| `payload` 长度 | 931 | 931 |
| `payload` SHA-256 前 16 位 | `6ee3ac2b7600ef3d` | `4919c47332ca9f25`（**不同**） |
| `MEDIA_TRACK_CREDENTIAL_KEY` | 未设置（走同一默认密钥） | 未设置（走同一默认密钥） |
| 刷新租约表 | 空 | 空 |

密钥相同而载荷密文不同 ⇒ **明文凭据已经分叉**：一方刷新过、另一方没有。这正是旋转冲突的指纹。

### 2.2 时间线

| 时间（UTC） | 事件 |
| :--- | :--- |
| 04:28:42 | 生产容器启动 |
| **09:59:00** | 生产首次 `FATAL ... requires re-authorization`（此后每 30 分钟复现：10:29、10:59、11:29） |
| 11:09:12 | 开发容器重启（当天若干次部署之一） |
| 11:31:55–11:31:59 | 开发侧仍在 `executeTokenRefreshWithRetry` 失败（40140137） |

24 小时计数：**开发 1251 次** 40140137、**生产 15 次**。

> 说明：生产在 09:59 就已失效，早于开发 11:09 的那次重启，所以**不是最后一次部署直接造成**的；但此前开发侧的多次重启同样会触发旋转。由于开发容器每次重建都会丢日志，无法逐次回溯更早的旋转事件——这是当前可观测性的缺口。

### 2.3 与代码提交的关系

- 今天唯一触碰相关文件的提交是 `652b5caa`，内容**仅为 3 行注释**（说明保留 `Connection: close` 的理由），无任何功能改动。
- `pan115-open-client.ts`（刷新核心）最后一次功能变更是 **2026-11-10** 的 `404485a4`。

结论：**没有代码层面的因果**。变的是"今天部署了 10+ 次"这一运行事实。

---

## 3. 现有机制为什么没挡住

| 机制 | 现状 | 为什么失效 |
| :--- | :--- | :--- |
| 跨进程刷新租约 | `tryAcquirePan115OAuthRefreshLease` + 续租 + 释放（`pan115-open-oauth-persistence.ts:74-139`） | 租约表在**各自 SQLite** 里；dev 与 prod 是两套库，天然互斥不了 |
| 刷新单飞（SingleFlight） | `tokenRefreshFlights.do(refreshKey, ...)` | 只在**进程内**去重 |
| 最小刷新间隔 | `MIN_REFRESH_INTERVAL_MS = 20min` | 存在 `Map` 内存中，**重启即清零** |
| 主动刷新阈值 | 剩余 ≤ 1 小时即刷新 | 每次重启后的第一个 tick 就可能命中，**把"重启"变成"旋转"** |
| 致命错误处理 | 30 分钟冷却 + 日志 | **不落库**：`status` 仍是 `active`，重启后照旧重试；UI 也看不到"需要重新授权" |

---

## 4. 方案

### 4.1 立即恢复（人工，1 分钟）

重新扫码授权即可（系统已有完整流程）：`/api/115/qrcode/image` → `status` → `confirm`。重新授权会下发**全新的一对 token**，两边都需重新绑定（见 4.2 的落地顺序，否则会再次冲突）。

### 4.2 根治：只允许一个「刷新写者」

| 方案 | 做法 | 优点 | 缺点 | 建议 |
| :--- | :--- | :--- | :--- | :--- |
| **A. 单写者（推荐先做）** | 约定只有生产实例刷新；开发实例设 `PAN115_OAUTH_REFRESH_DISABLED=1`，只读 token、过期即报"需在生产重新授权" | 零基础设施改动；彻底消除双写 | dev 无法独立验证长时播放 | **P0** |
| **B. 跨实例租约** | 租约外置到共享存储（Redis / 宿主机文件锁 / 内部协调端点） | 任意多副本安全 | 引入外部依赖或运维约束 | P1 |
| **C. 共享凭据库** | 两实例共用一个数据库（只读副本读主库凭据） | 天然一致 | 违背 dev/prod 数据隔离原则 | 不推荐 |
| **D. 各自独立账号** | dev 用另一个 115 账号 | 物理隔离 | 需第二个账号；测试数据不通用 | 可选 |

### 4.3 降低"重启即旋转"

- **改为惰性刷新**：启动时不做主动刷新，只在真正发起 115 请求且 `expiresAt - now < 10min` 时才刷新。重启不再等于旋转。
- 保活阈值从 1 小时下调到 10–15 分钟，减少无谓旋转次数。
- 把 `lastRefreshedAt` 从内存挪到 DB（或至少把"上次刷新时间"写进凭据载荷），让冷却跨重启生效。

### 4.4 失效可观测（必须）

- 捕获 `40140137` / `40140116`（`classify115OpenError` 已判定为 fatal）后，把 `connected_storages.status` 置为 `needs_reauth`（或写 `frozen_reason`），**停止后续重试**。
- 前端在网盘卡片与设置页展示"授权已失效，请重新扫码"，并提供一键跳转。
- 记录旋转审计：`{storageId, at, instanceId, result}`，用于事后判断"谁把谁打死了"。

### 4.5 复用检测风险提示

OAuth 2.0 Security BCP 建议：检测到**已轮换的 refresh_token 被再次使用**时，授权服务器应吊销整条链。115 的 `40140137` 与"两侧同时失效"的观测与此一致。因此**任何"重试旧 token"的实现都是危险动作**——现有 `refreshCredentialsFromCurrentToken` 的 catch-up 循环（最多 4 次）应在拿到 40140137 后立即终止，而不是继续尝试。

---

## 5. 设计模式落点

| 模式 | 落点 | 作用 |
| :--- | :--- | :--- |
| **领导者选举 Leader Election** | 刷新权归属：`PAN115_OAUTH_REFRESH_DISABLED`（A）或外部租约（B） | 保证同一时刻只有一个写者 |
| **单飞 SingleFlight** | 已有 `tokenRefreshFlights` | 进程内去重（保留） |
| **状态机 State** | `valid → refreshing → requires_reauth`，写库持久化 | 让"需要重新授权"成为一等状态，而不是日志里的一行 |
| **装饰器 Decorator** | 在 `Pan115OpenClient` 外包一层"只读令牌代理"（dev 用） | dev 无需改业务代码即可禁写 |
| **审计日志 Audit** | `oauth_rotation_log` | 多副本冲突可追溯 |

---

## 6. 业界对照

| 来源 | 做法 | 对本项目的启示 |
| :--- | :--- | :--- |
| **OAuth 2.0 Security BCP**（draft-ietf-oauth-security-topics） | 旋转 + 复用检测 + 吊销整链 | 重试旧 token 是禁忌；必须持久化"已轮换"事实 |
| **Google OAuth 多副本** | 建议集中存储 token，或按实例隔离凭据 | 多副本共享一个旋转令牌本身就不被推荐 |
| **Microsoft identity platform** | 明确 refresh_token 单次有效，需串行化刷新 | 串行化需要跨实例协调，不能只靠进程内锁 |
| **Jellyfin / Emby 插件生态** | 单实例部署，token 只存一份 | 单实例是最省事的解法——本项目 dev/prod 双实例是自找的复杂度 |

---

## 7. 可复用资产

| 资产 | 位置 | 用途 |
| :--- | :--- | :--- |
| 刷新租约表与协调器 | `pan115-open-oauth-persistence.ts:74-139` | 方案 B 只需把 repository 换成共享实现 |
| 错误分类 | `pan115-open-client.ts:45-48`（`40140116` / `40140137` 判为 fatal） | 直接驱动 `requires_reauth` 状态 |
| 凭据持久化钩子 | `onCredentialsPersist` + `createPan115OpenOAuthPersister` | 旋转结果落库已有保障（含"持久化失败即抛错"的保护） |
| 保活冷却 | `pan115-token-keepalive.ts`（30min/5min） | 只需补"落库 + 降频" |
| 扫码授权流程 | `/api/115/qrcode/{image,status,confirm}` | 恢复入口已具备 |
| `connected_storages.status` / `frozen_reason` | schema 已有字段 | 无需迁移即可承载 `needs_reauth` |

---

## 8. 门禁与回归测试（防复发）

### 8.1 静态门禁（硬阻断）

1. **开发实例不得刷新**：新增 lint/test 断言——当 `NODE_ENV !== "production"` 且 `PAN115_OAUTH_REFRESH_DISABLED !== "1"` 时，keepalive 必须**不**注册刷新任务（或直接断言该 env 在 dev 部署脚本中恒为 `1`）。
2. **禁止裸重试致命错误**：断言 `refreshCredentialsFromCurrentToken` 的 catch-up 循环在 `isFatal` 时立即 `break`（AST 或行为测试）。

### 8.2 单元/集成测试

```
双副本模拟（关键）：
  repoA / repoB 各自持有同一初始 refresh_token
  共享一个「假 115 刷新端点」，每次调用轮换 token 并作废旧值
  → 并发触发 A、B 刷新
  → 断言：只有一次成功轮换；另一方要么等待租约后复用新值，要么得到 requires_reauth
  → 断言：全程只有 1 次真实网络刷新
```

```
失效落库：
  注入 40140137 → 断言 status 变为 needs_reauth、后续 N 秒内无第二次刷新请求
```

```
重启语义：
  写入 lastRefreshedAt → 模拟进程重启（清内存）→ 断言冷却仍生效（来自 DB）
```

### 8.3 浏览器回归

网盘页在 `needs_reauth` 状态下应展示"授权已失效"与"重新扫码"入口；点击进入扫码流程（可用 mock 状态断言，不依赖真实扫码）。

---

## 9. 实施计划

| 期 | 内容 | 成本 | 验收 |
| :--- | :--- | :--- | :--- |
| **P0** | 重新扫码恢复 + dev 禁止刷新（env 开关 + 门禁） | 0.5 天 | 连续部署 5 次后 prod token 不再失效 |
| **P1** | 失效落库 `needs_reauth` + 停止重试 + UI 提示 | 0.5 天 | 注入 40140137 后状态与 UI 正确 |
| **P2** | 惰性刷新（启动不刷新）+ 阈值降到 15min + 冷却持久化 | 1 天 | 重启不再触发旋转（日志断言） |
| **P3**（可选） | 跨实例租约（Redis/文件锁/协调端点） | 1–2 天 | 双副本并发刷新只发生一次 |

---

## 10. 风险与边界

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| dev 禁写后无法验证长时播放 | dev 的 token 过期就得去 prod 重新授权 | 可选方案 D：给 dev 单独账号 |
| 惰性刷新导致首次请求变慢 | 过期瞬间才刷新，多一次往返 | 保留"使用前 ≤10min 预刷新"，兼顾 |
| 外部租约引入运维成本 | 需要 Redis 或共享卷 | 先用 P0 的单写者约定，P3 视需求再上 |
| 重新授权丢失旧绑定 | confirm 流程会覆盖凭据 | 已有 upsert 语义；建议授权前提示"将替换现有令牌" |

---

## 11. 附：本次取证命令（可复现）

```powershell
# 容器内查询（不输出任何明文凭据，仅指纹）
docker cp /tmp/inspect-oauth.mjs mediary-dev:/tmp/ && docker exec mediary-dev node /tmp/inspect-oauth.mjs
docker cp /tmp/inspect-oauth.mjs mediary:/tmp/     && docker exec mediary     node /tmp/inspect-oauth.mjs

# 失效日志计数与时间线
docker logs -t --since 24h mediary     | grep -c 40140137
docker logs -t --since 24h mediary-dev | grep -c 40140137
docker inspect -f '{{.Name}} {{.State.StartedAt}}' mediary-dev mediary
```
