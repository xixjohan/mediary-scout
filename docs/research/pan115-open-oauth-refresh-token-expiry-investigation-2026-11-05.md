# 115 Open OAuth refresh_token 失效与自动刷新链路调研（2026-11-05）

## 摘要结论

用户看到 `40140137: refresh_token 已失效，请停止重试并重新授权`，表示当前这次刷新请求所带的 refresh token 已被 115 拒绝。它不是 access token 普通过期的同义状态；access token 过期本来应由 refresh token 换新。

本地代码中有两条可确认的“刷新成功但新令牌没有可靠持久化”缺陷，足以解释为何界面先显示已授权、自动刷新看似工作，过一段时间却要求重扫：

1. Open OAuth 刷新回调得到 `{ accessToken, refreshToken, expiresAt }` 扁平对象，但通用 `makeTokenPersister()` 使用网盘品牌的常规凭据提取器校验。115 品牌是 Cookie 认证形态，扁平 OAuth 对象提取不到常规 credential，因此记录 `incomplete blob ... skip persist` 后正常返回。调用方会误以为保存成功。
2. 直链解析器在 `stream-resolver.ts` 里构造 `new Pan115OpenClient({ credentials: openOAuth })`，没有设置 `onCredentialsPersist`。刷新后新值只存在该解析器缓存的客户端内存；进程重启后从数据库读取旧 refresh token。

此外，刷新互斥目前是每个 `Pan115OpenClient` 实例内的 `SingleFlight`。保活、诊断、存储 executor、直链解析可能各自创建客户端；多个实例无法互斥，可能在轮换窗口同时使用同一个旧 refresh token。LitePan 的参考实现将锁放在账号认证服务层，而不是驱动实例内部。

**仅从这段 UI 错误不能断定这一个账号的 refresh token 是由哪条路径丢失或被谁吊销。** 但上面两项是代码层已确认的缺陷；其它成因需结合刷新日志、数据库令牌版本变更和授权记录判断。当前已被官方判无效的 refresh token 不能靠重试恢复，需重新扫码授权。

## 现象与语义

- `OAuth 状态：已授权` 只说明本地凭据对象存在，不代表远端仍接受它。
- `API 延迟：3328 ms` 表示诊断请求经历了网络/刷新往返，不能单独证明刷新成功或写库成功。
- `令牌剩余 TTL：已过期` 是本地记录的 access-token `expiresAt` 已经过期，不等同于 refresh token 的官方剩余寿命。
- `40140137` 当前被 `Pan115OpenClient` 分类为致命刷新错误；客户端不对该授权错误自动重试，这是正确的停止条件。自动重试无效 refresh token 只会重复失败并可能触发限流。

## 本项目链路审计

### 刷新机制确实存在

- `packages/workflow/src/storage/pan115-open-client.ts` 的 `ensureValidToken()` 在 access token 临近过期/失效时调用 `/open/refreshToken`，更新实例内存中的 access token、refresh token 和 expiresAt。
- 单个 client 实例使用 `SingleFlight` 合并刷新；瞬态错误有有限退避；授权错误分类为 fatal。
- `apps/web/lib/pan115-token-keepalive.ts` 接在常驻 background worker 上，定期检查 115 Open OAuth；在 access token 到期前主动刷新，并对结果做内存冷却。
- `apps/web/features/storage-drives/application/drive-service.ts` 的诊断探活也会构造 `Pan115OpenClient` 并尝试刷新。

因此答案是：**自动刷新逻辑有运行入口，但刷新成功到持久化的闭环不可靠。** 现场部署日志曾出现 keepalive 对同一 storage 报致命 refresh 错误，说明 worker 至少实际执行过刷新尝试；它不能证明此前刷新是否成功写回。

### 已确认缺陷 A：OAuth 专用凭据被通用 persister 误判

`Pan115OpenClient.ensureValidToken()` 将轮换后的凭据交给 `onCredentialsPersist`。keepalive 和诊断都把 `makeTokenPersister(accountId, storageId, provider)` 作为回调。

但 `makeTokenPersister()` 当前将回调参数视为完整网盘 payload，执行 `extractStorageCredential(provider, blob)`。对于 `pan115`，常规 credential 提取依据 Cookie 品牌；回调参数却只是扁平 OAuth 三字段，没有 `cookie` 或嵌套 `openOAuth`。验证失败后函数只写一条 warning 并 `return`。因而即使 115 已成功签发新 refresh token，旧版本仍留在数据库，而 `Pan115OpenClient` 看不到持久化失败。

具体代码位置：

- `packages/workflow/src/storage/pan115-open-client.ts`：更新内存凭据并 await 持久化回调；回调异常被 catch 后记录，但不向上抛。
- `apps/web/features/storage-drives/application/drive-service.ts`：`makeTokenPersister()` 对不完整凭据跳过写库，异常也被 catch。
- `apps/web/lib/pan115-token-keepalive.ts`、`drive-service.ts` 诊断探活：将该通用 persister 用于 Open OAuth 刷新。

### 已确认缺陷 B：Open API 直链刷新没有持久化回调

`packages/workflow/src/storage/stream-resolver.ts` 的 `ProductionStorageStreamResolver` 构造 Open client 时只传 `credentials`，没有 `onCredentialsPersist`。`getDownloadUrl()` 仍会经过 `ensureValidToken()`，但刷新后的 token 只保留在 resolver 缓存的 client；数据库并未收到新 token。服务下次重启后会重新加载旧 refresh token。

### 竞态风险：SingleFlight 的范围不足

当前 `SingleFlight` 实例字段属于一个 `Pan115OpenClient`。保活、诊断和直链解析创建的不同 client 没有共享它；多个请求可能同时读取同一代 refresh token 并向 115 刷新。若 115 对令牌轮换/重放执行旧 token 失效，先成功者产生的新 token 与后续旧 token 请求相撞，数据库最终也可能保留错误版本。

### 其它可能成因（需日志/环境证据确认）

- 同一授权同时被 LitePan、AList/OpenList、脚本或另一 Mediary 实例刷新，导致本实例持有旧代令牌。
- 用户重复扫码获取令牌、撤销设备/应用授权、修改账号安全设置或遭遇官方风控。
- background worker 暂停、实例长时间离线或系统休眠，超过服务端允许的非活跃周期。
- 数据库写失败、写入竞争或备份恢复回滚到旧凭据。
- 115 服务端策略变化、IP 频率限制或其它授权状态变更。

外部复用是实质风险：OpenList 的 115 Open 驱动文档说明刷新接口有 IP 频率限制，并提示同一账号同一应用获取过多 refresh token 时，较早签发的 token 会失效。该说明属于 OpenList 项目文档，不是 115 官方生命周期保证。不能据此推断 refresh token 固定活 30 天或某个确切时长。

## 为什么用户感觉 refresh_token“容易过期”

常见场景并非服务器只给了很短的寿命，而是**本地仍保存的值已经不是最新一代**：

1. 某个调用成功刷新并获得新 refresh token；
2. 回调未接入持久化，或者错误被吞掉；
3. 进程继续运行时内存 client 暂时可用；
4. 重启/切换 client/下一次保活后从数据库拿旧 token；
5. 115 拒绝旧 token，报告 refresh token invalid/expired。

非活跃过期、官方撤销和多应用重放也可能发生，但当前项目两个持久化缺口应先修。OAuth 安全最佳实践允许授权服务器设置 refresh token 非活跃过期并撤销 token；若服务器使用 rotation，成功刷新后客户端必须用新 refresh token 替换旧 token。参见 RFC 6749 §6 与 RFC 9700 §4.14。

## LitePan-main 对照

调研参考目录 `E:\WorkProject\Go\【第三方项目】\Litepan\LitePan-main`：

- `drivers/115_Open/auth.go` 的 `exchangeToken()` 取得新的 access/refresh token 后，先更新驱动字段，再调用 `d.persist(...)`；持久化错误会返回错误，不伪装成成功。
- `internal/auth/refresh_runner.go` 提供主动/被动统一刷新入口，刷新前获取 per-account 锁，读最新状态并检查 cooldown。
- `internal/auth/control.go` 的 `recentlyRefreshed()` 读取持久化认证状态，避免刚刚刷新后再次用旧状态刷新；失败状态带 retry/cooldown。
- `internal/auth/scheduler.go` 集中调度到期账号，调用统一 auth service，而不是让每个请求构建独立刷新调度。

LitePan 的可借鉴点是**账号级协调、写入失败传播、刷新结果及时持久化、失败状态统一治理**。它的 Go 代码不是本项目可直接安装的 npm 库。

## 业界方案与库复用

| 方案 | 刷新协调 | 轮换结果保存 | 失败语义 | 本项目适用点 |
|---|---|---|---|---|
| OAuth 2.0 RFC 6749 | 协议定义刷新请求/响应 | 若下发新 refresh token，客户端必须替换旧值 | `invalid_grant` 等授权错误不可盲重试 | 作为令牌生命周期与替换的协议基线 |
| OAuth 2.0 Security BCP RFC 9700 | 推荐 rotation 或 sender-constrained 等 replay 防护 | 服务端可撤销旧 token；可设置非活跃过期 | 安全事件/重放可能撤销整个 token family | 说明“同一 token 多处共享”有真实风险 |
| LitePan-main | 每账号锁 + 主动/被动统一 service | 驱动内联刷新立即持久化，错误向上返回 | 可区分 fatal/retryable，并有 cooldown | 最贴近本项目的架构参考 |
| AList / OpenList 115 Open | SDK callback 或驱动 refresh callback | callback 中更新 driver config 并保存 storage | 驱动区分授权失效与限流；OpenList 文档注明刷新有 IP 限流 | 借鉴刷新回调必须落盘及避免无节制刷新 |
| 本项目现状 | client 实例级 SingleFlight + background keepalive | 多处走通用 persister；直链 resolver 无 callback | 有 fatal 分类，但 persister 吞写入问题 | 可复用现有 client、SingleFlight、SQLite repo、worker；无需 OAuth 新库 |

当前依赖中没有 115 Open 专用 OAuth SDK。Node 原生 `fetch`、项目已有 `Pan115OpenClient`、`SingleFlight`、credential 加密存储、SQLite repository 和 background worker 足够。加通用 OAuth 库不会自动修复本地 payload 结构、账号级锁和持久化事务；不建议为了本问题新增依赖。必要时只需新增面向 storageId 的应用层 Token Coordinator。

## 解决方案

### P0：修复持久化契约

1. 增加独立 `persistPan115OpenOAuth(accountId, storageId, nextCredentials)`，从仓库读取最新 storage payload，保留 cookie、`engineMode`、`meta` 及目录配置，只替换 `payload.openOAuth`。
2. 通过 repository 的原子更新/CAS 或 SQLite transaction 写回，避免并发刷新和其它 storage 更新覆盖彼此字段；更新后读取并核对新 expiresAt/令牌版本（不记录明文 token）。
3. Open OAuth persister 遇到记录不存在、校验失败或数据库写入失败必须 reject。不得把“跳过保存”作为成功返回。
4. `Pan115OpenClient.ensureValidToken()` 在刷新 token 已轮换但写库失败时不能返回正常成功。由于远端旧 token 可能已失效，应将账号状态标为 `persistence_uncertain`/需要重授权提示，不应盲目用旧 token 重试。
5. `ProductionStorageStreamResolver` 必须接收 storageId 对应的持久化回调；不能有 Open OAuth client 在有持久化存储语境下无回调运行。

### P0：账号/网盘级刷新协调

1. 把刷新互斥从 `Pan115OpenClient` 实例提升为进程内 per-storage `TokenCoordinator`，所有构造路径共用；锁内重新读取 DB 最新凭据，检查 access token 是否已被其他调用更新，再决定刷新。
2. 单进程部署可先用 keyed mutex/SingleFlight；若 Web 与独立 worker、多实例会同时持有同一 storage，进程内锁不够，需通过 SQLite claim/lease + version/CAS 保证跨进程只有一个刷新者。
3. 成功后先持久化，再向业务请求返回新 token；随后让同一 storage 所有 client 更新/丢弃缓存凭据。

### P1：统一主动与被动状态机

状态建议：`valid → refreshing → persist-verified → valid`；瞬态网络/限流进入 `cooldown → retryable`；`40140115/16/19/20/37` 等授权失效进入 `reauthorization-required`；DB 写回不确定进入 `persistence-uncertain`。致命状态停止自动刷新，UI 提示扫码；瞬态状态采用有上限的指数退避与随机抖动。

继续复用已有 background worker 做主动保活、API 请求做被动刷新；二者调用同一个 coordinator。保活阈值和频率需保守配置，避免 115 IP 限流；每次 tick 不代表每次都请求刷新。

### P1：可观测性与排查

- 记录 storageId、调用来源（keepalive/stream/diagnostics/executor）、旧 expiresAt、新 expiresAt、持久化成功/失败、刷新代数或不可逆短 fingerprint、耗时与错误码；绝不记录 access/refresh token 明文。
- 诊断区分 `credentials_configured`、`access_token_expired`、`refresh_succeeded_persisted`、`reauthorization_required`、`persistence_uncertain`。
- 增加持久化失败通知和最后成功刷新时间；不得把 token 存在数据库等同 OAuth 健康。
- 对已有失效授权，实施修复后仍需用户重新扫码一次，获取系统可持久化的新令牌。

## 防回归测试与门禁

1. **专用 persister 合约**：输入 flat `Pan115OpenOAuthCredentials`，断言仅更新 `payload.openOAuth`，原 Cookie、engineMode、meta、分类目录字段完整保留。
2. **持久化失败必须可见**：repository reject/目标 storage 不存在/凭据校验失败时，callback reject，`ensureValidToken()` 不返回成功，worker/诊断报告 persistence error。
3. **直链刷新落库**：过期凭据通过 `ProductionStorageStreamResolver.getDownloadUrl()` 触发刷新；断言 repository 保存新 refresh token 与 expiresAt；销毁并重建 resolver 后仍可用新值。
4. **各入口闭环**：keepalive、diagnostics、storage executor 和 stream resolver 都通过同一个 coordinator/persister；无持久化回调的服务端 Open client 构造必须由测试/静态门禁发现。
5. **并发轮换测试**：同一个 storage 对过期凭据并发发起 50–100 个 list/stream/diagnostic 请求；假 fetch 验证 refresh endpoint 仅一次调用，所有请求共享新 access token，DB 只写入新 refresh token。
6. **双进程/CAS 测试**：两个 coordinator 同时 claim 同一 token version，只允许一个 refresh；另一方重读已更新版本而不提交旧 token。
7. **重启回归**：刷新后模拟 worker/client 重建，从 repository 读取新 refresh token；不得再用旧 refresh token 请求端点。
8. **错误状态机**：40140137/40140120 进入需重授权、不做指数重试；429/40140121/502/超时按 cooldown 退避，其他 storage 仍继续保活。
9. **外部轮换场景**：模拟另一客户端先轮换，使本地旧 token 返回 fatal；报告明确是重新授权所需，不把它显示为普通 access token 超时。
10. **静态门禁**：`Pan115OpenClient` 在持久化 storage 场景下所有构造点必须提供统一 `TokenCoordinator`；禁止直接将 `makeTokenPersister` 用作 Open OAuth callback，防止扁平数据被常规 credential extractor 误判。

## 最终判断

调查时确认：自动刷新逻辑存在，但刷新成功到持久化的闭环不可靠。通用 `makeTokenPersister` 的数据形状与 Open OAuth 回调不匹配且会吞错，直链解析器没有持久化回调；因此刷新请求会发起，但新 refresh token 不保证保存。本轮已修复持久化契约，并使用 SQLite 租约协调共享同一数据库的 Web 与独立 Worker；所有持锁路径都会先重读最新凭据，再决定刷新或复用。无需添加新的 OAuth SDK。与本系统共享同一数据库的刷新入口可互斥；其它应用或另一套独立数据库无法参与本地租约，仍可能在 115 端触发令牌重放。

## 本轮实施结果（2026-11-05）

- 新增 115 Open OAuth 专用 persister：SQLite 在单个事务内读取、比较并只更新 `payload.openOAuth`，保留 Cookie、`engineMode`、`meta` 和分类目录；缺记录、过期写入、数据无效或写库失败均会 reject，避免旧轮换结果覆盖更新的 token。
- `Pan115OpenClient` 现在在持久化成功前不返回轮换后的 token；写回失败会保留待写凭据，后续调用先重试写回。进程内不同 client 的 refresh 请求按旧 refresh token 合并，并保留有容量上限的轮换结果缓存，供稍晚启动的旧 client 复用。
- 新增 SQLite `pan115_oauth_refresh_leases` 租约表：Web 与独立 Worker 通过原子 claim 协调同一 storage 的刷新；持有者定时续租，正常结束时按 owner 释放，进程崩溃后可在租约过期后接管。取得租约后从数据库重读凭据，已被先行刷新时不再把旧 refresh token 发往 115。
- 补齐 `40140137` 的致命错误分类；刷新退避现在只重试被分类为 retryable 的错误，已失效 refresh token 只请求一次并要求重新授权。
- 专用 persister 已接入 background keepalive、Open OAuth 诊断、115 storage executor 和 STRM 直链解析；Open OAuth-only 凭据也会沿 executor 凭据链路传递。连接/校验流程会保存校验期间实际获得的最新凭据。
- 已增加回归覆盖：payload 保留、缺失记录和数据库错误传播、写回失败后的重试、不同 client 并发及迟到旧 client 复用轮换结果、跨 SQLite 连接的排他租约/过期接管、两个协调器并发时仅一次刷新、直链刷新写回与待写重试。
- **部署边界**：SQLite 租约只协调共用同一个数据库文件的 Mediary 进程。其它客户端或独立数据库无法加入该锁；旧 token 若已在系统外被轮换或撤销，仍需用户重新授权。
- 已被 115 撤销的旧 refresh token 无法由本次修复恢复；该存储仍需重新授权一次。

## 参考

- RFC 6749 §6 Refreshing an Access Token：<https://www.rfc-editor.org/rfc/rfc6749.html#section-6>
- RFC 9700 §4.14 Refresh Token Protection：<https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14>
- OpenList 115 Open 驱动说明（项目文档，含 refresh 回调、IP 限流及令牌获取次数说明）：<https://github.com/OpenListTeam/OpenList-Docs/blob/main/pages/guide/drivers/115_open.md>
- AList 115 Open 驱动（SDK 刷新回调后保存 storage）：<https://github.com/AlistGo/alist/blob/main/drivers/115_open/driver.go>
- 本地 LitePan-main：`internal/auth/refresh_runner.go`、`internal/auth/control.go`、`internal/auth/scheduler.go`、`drivers/115_Open/auth.go`
- 本地 Mediary Scout：`packages/workflow/src/storage/pan115-open-client.ts`、`packages/workflow/src/storage/stream-resolver.ts`、`apps/web/lib/pan115-token-keepalive.ts`、`apps/web/features/storage-drives/application/drive-service.ts`
