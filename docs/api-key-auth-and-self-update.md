# API Key 认证 + 自包含更新 · 可行性与方案

> 任务单 **S5.1 ~ S5.5**（2026-10-27 起）。
> 输入：用户提出的 5 项需求 → 先头脑风暴（可行性/逻辑/性能/设计模式）→ 库与业界调研 → 落地方案 → 执行。
> 本文是该程序的唯一跟踪入口；执行状态见 §8。

---

## 1. 需求与现状基线

| # | 需求 | 现状（已代码踏勘） | 结论 |
|---|---|---|---|
| F1 | 去除「🎉 付费远程访问现已上线」横幅 | `apps/web/components/connect-notice-banner.tsx`，被 `app/page.tsx:109` 渲染；关闭态存 `app_settings`（`CONNECT_NOTICE_DISMISSED_KEY`） | **直接删组件+调用点+样式+server 条件**，零风险 |
| F2 | API key 登录换 JWT，所有接口加认证（登录除外） | 已有 HMAC 会话 cookie（`packages/workflow/src/auth/session.ts`，`timingSafeEqual` + `createHmac`）；`requireAuthenticatedAccountId()` 已存在于 workflow-runtime；**36 个 api 路由中约 1/3 无鉴权**（写作时快照；交付时为 40 个：12 白名单 + 5 agent 自守卫 + 23 登录链）（`agent/acquire`、`settings/attention`、`agent/*` 等） | 可行，但**必须先做一张"路由 × 鉴权"清单**，见 §3 |
| F3 | API key 读环境变量 + 数据库，**数据库优先** | `app_settings` 表 + `setSetting/getSetting`；`SECRET_SETTING_KEYS` 注册表已对 `llm_api_key`/`tmdb_api_key` 等做 AES-256-GCM 透明加密 | 可行，**api key 入加密注册表**，一次读两源、DB 覆盖 env |
| F4 | 设置页 API key 查看/修改 | 设置页已是分节组件（`Pan115Section`/`LlmConfigSection`/`TmdbApiKeySection`…）；`TmdbApiKeySection` 就是现成范式 | 可行，**照 `TmdbApiKeySection` 加一节** |
| F5 | 在线更新地址改为当前仓库 | 硬编码在 `apps/web/lib/release-feed-server.ts:4`（`const REPO = "fancydirty/mediary-scout"`）与 `updater/run-update.sh` 的 `IMAGE_BASE` | 可行，**改为 env 可配 + 默认当前仓库** |

---

## 2. 头脑风暴：可行性 / 逻辑 / 性能 / 风险

### 2.1 总体判断
五项**全部可行**，且大部分是在现有骨架上的延伸（不是新架构）。真正的风险集中在 F2 的"全接口认证"——**它是唯一可能把现有功能改坏的一项**，必须清单驱动、默认拒绝、白名单例外。

### 2.2 F2 的逻辑难点（重点）

**难点 A：天生不能要用户登录的调用方有四个，必须白名单而非"全部拦截"**

| 调用方 | 路由 | 现有鉴权 | 处置 |
|---|---|---|---|
| Docker healthcheck /  uptime 监控 | `GET /api/health` | 无（刻意，探针用） | **保持免登录**（只回 ok/503，无敏感数据；文档已声明可暴露） |
| 独立 worker（HTTP poke） | `POST /api/workflows/run-next`、`/run-type3` | `x-media-track-worker-secret` 头 | **保持现有 secret 机制**（它是"服务间"凭据，不是用户会话） |
| 一键更新执行者 | `/api/update/hold`、`/busy`、`/status` | `isUpdaterToken(authorization)`（卷内令牌） | **保持现有机制** |
| 登录/登出/引导/改密本身 | `/api/auth/*` | — | **免登录**（否则死锁） |

→ 结论：需求"除了登录都免登录"要**修正为"除 §2.2-A 白名单外都需登录"**，否则 healthcheck 会掉、worker 会 401、更新助手会瘫痪。这一点必须和用户确认（已在本轮提问中给出）。

**难点 B：浏览器会话与 API 令牌必须并存**
页面是用 session cookie 渲染的（服务端组件直接读 session）。若只认 JWT，所有 SSR 数据加载会 401。→ 设计为 **`resolveAccount(request)` 双通道**：先试 session cookie，再试 `Authorization: Bearer <jwt>`，任一通过即认证。对前端零改动，对 API 客户端零改动（统一 Bearer）。

**难点 C：JWT 的密钥管理**
- 复用 `session_secret`（`app_settings` 加密项）会**把会话与令牌生命周期耦合**——轮换 session secret 会一次性吊销所有 JWT（可接受，但要有意识地接受）。
- 建议**独立 secret**：`MEDIA_TRACK_JWT_SECRET` env 覆盖，否则落到 `app_settings` 的 `jwt_secret`（入加密注册表，自动生成 32 字节随机）。
- 争议点：自托管单实例场景，短存活 JWT（如 12h）意义有限；但**换 token 的接口仍然要有**，因为"API key 长期不变、JWT 可轮换"正是这个需求的价值。折中：默认 12h，env 可调。

**难点 D：API key 落库不能明文**
- 现状加密是**可逆**的（AES-256-GCM，因为要拿回明文去调 TMDB/LLM）。API key 若也要可逆，等于和那些凭据同风险级。
- 业界主流是**单向哈希**（GitHub/Stripe 都只存哈希，创建时展示一次）。但本需求 F4 要求"设置页修改/查看"——查看意味着要能回显。
- **折中方案（推荐）**：落库走现有 GCM 加密（与其它凭据一致、可回显、可撤销）；**展示时只回显末 4 位**，完整值仅在创建/轮换响应里出现一次。同时 `timingSafeEqual` 比对（防时序侧信道）。
- 备选：`sha256(key)` 存哈希 + 前缀索引（`sk-xxxx`）——更安全但**不能回显**，与 F4"查看"冲突。将此作为"若用户接受不可回显"的升级项记录。

**难点 E：env 与 DB 的优先级语义**
"数据库优先"要定义清楚三种情形：
1. 两者都有 → 用 DB（用户需求）。
2. 只有 env → 用 env（**不可撤销**：删不掉，只能改 env 重启 —— 要在设置页明示"当前生效来自环境变量，无法在页面撤销"）。
3. 只有 DB → 用 DB。
4. 都没有 → 功能关闭（所有接口按现状：session 认证照常，不因没配 API key 而坏）。

### 2.3 性能
- **HMAC 校验 O(1)、无 DB 查询**：session 设计与 JWT 验证都不查库（撤销靠短过期 + secret 轮换）。40 个路由每请求多一次 `createHmac`/`jwtVerify`，Web Crypto 的 HS256 验证约 **50–100µs**，相对现有 SQLite 查询（ms 级）可忽略。
- **jose 是 async API**（Web Crypto）：在 Next route handler 里 `await jwtVerify()` 无阻塞问题；但**不要放进 middleware 的热路径做多余工作**——middleware 只解析Bearer头、验签，业务账户解析留给路由内一次完成。
- **API key 解析每请求一次 DB 读**：`getSetting` 是 SQLite 点查（µs 级），但可加 30s 进程内缓存；key 变更后**最多 30s 生效**——这与"数据库优先"语义兼容（写后立即生效是更强的诉求，若用户要求，则去掉缓存，点查也足够快）。

### 2.4 设计模式落点（对齐本仓库现有模式）

| 模式 | 用在哪 | 与现状的衔接 |
|---|---|---|
| **策略模式** | `ApiKeySource` 策略：`EnvApiKeySource` / `DbApiKeySource` / `DisabledApiKeySource`，由 `resolveApiKey()` 按优先级选路 | 与 `createBrandPacer`、`StorageExecutor` 工厂同款；新文件 `packages/shared/src/api-key-source.ts` |
| **适配器/端口** | `IApiKeyStore`（revoke/rotate/verifyMask）入 `packages/contracts`，SQLite 实现入 workflow 包 | `packages/contracts` 已有 4 个基础设施端口，直接扩展 |
| **责任链** | `Authenticator` 链：`SessionCookieAuthenticator` → `BearerJwtAuthenticator` → `WorkerSecretAuthenticator`（仅/workflows）→ `UpdaterTokenAuthenticator`（仅/update）→ 401 | 每个 authenticator 只回答"这是不是你管的凭据" |
| **状态机** | API key 生命周期 `absent → active → rotating(旧key宽限) → revoked` | 仓库已用 XState（acquisition-v2）。**评估后建议不用 XState**：状态仅 4 个且无并发补偿诉求，用 TS 判别式联合 + 纯函数更轻；若将来加"双 key 宽限期"再上 FSM。**明确记录此为有意识的取舍** |

---

## 3. 库调研与选型

| 库 | 许可 | 体积/依赖 | 运行时 | 结论 |
|---|---|---|---|---|
| **jose** v5（调研时最新；交付时装的是 **v6**）| MIT | 0 依赖，~100KB | Node/Edge/Workers（Web Crypto） | ✅ **选它**。RFC 7519 全套、Auth.js/Hono 内部都用它、`none` 算法默认拒绝 |
| jsonwebtoken | MIT | 0 依赖，~70KB | **仅 Node**（crypto） | ❌  legacy；同步 API 在 middleware 里反而诱人写阻塞代码 |
| fast-jwt | Apache-2.0 | 0 依赖 | 仅 Node | ❌ 性能场景（本项目不需要 µs 级） |
| @node-rs/argon2 等 | — | 原生绑定 | — | ❌ 本项目 API key 是**服务端持有的长期凭据**（不是用户口令），不需要慢哈希 |

依据：[PkgPulse 2026 对比](https://www.pkgpulse.com/guides/jose-vs-jsonwebtoken-vs-fast-jwt-jwt-libraries-nodejs-2026)、[jose npm](https://www.npmjs.com/package/jose)、[Curity JWT 最佳实践](https://curity.io/resources/learn/jwt-best-practices/)、[Aembit: API Keys vs JWTs](https://aembit.io/blog/api-keys-vs-jwts/)。

**决策：新增 `jose` 到 `packages/shared`（HS256，12h，secret 由 env 或加密 settings 提供）。**

## 4. 业界主流方案对标

| 方案 | 模式 | 借鉴点 |
|---|---|---|
| **GitHub**（PAT → installation token） | 长期 key 换短期 token | ✅ 本需求就是这一式：API key（长期）→ JWT（12h） |
| **Stripe**（`sk_live_…`） | key 直接 Bearer，无交换 | 简洁但不可撤销单key；不适合"页面可改"的诉求 |
| **AWS SigV4** | 请求签名 | 过重，自托管单实例不需要 |
| **OpenAI / Anthropic** | `Authorization: Bearer sk-…` 直接用 key | 若用户想要"最简"可降级到这一式（跳过 JWT）——**列为备选，不推荐**：丢失了轮换能力 |
| **Auth.js (NextAuth)** | 完整 OAuth 会话框架 | ❌ 本应用已有自有会话（HMAC cookie），引入框架等于重写认证；只借鉴其"jose 作为底层"的选型 |

---

## 5. 实施方案（按任务单）

### S5.1 移除横幅（F1）
- 删 `components/connect-notice-banner.tsx`、`app/page.tsx` 的 import+渲染、`connect-notice-server.ts` 中该 banner 的条件装配、`connect-notice.ts` 的 dismissed key 逻辑（若无其它使用者）、对应样式与测试。
- 验收：首页无横幅；`shouldShowConnectNotice` 相关测试改为断言"不再展示"或删除；全量回归绿。

### S5.2 API Key 策略 + 端口（F3 的地基）
- `packages/shared/src/api-key-source.ts`：`resolveApiKey(env, store)` → `{ value, origin: "db"\|"env"\|"none", masked }`，**DB 优先**；`mask` 只露末 4 位。
- `packages/contracts`：`IApiKeyStore { get/put/rotate/clear }`；`SqliteApiKeyStore`（workflow 包）落 `app_settings`，key 名 `api_key`，**入 `SECRET_SETTING_KEYS`**（自动 GCM 加密）。
- 测试：四象限（仅 DB / 仅 env / 都有→DB / 都无）、掩码、加密落盘（读文件是 `enc:v1:`）、`timingSafeEqual` 语义。

### S5.3 JWT 颁发与验证（F2 的地基）
- `packages/shared/src/auth/jwt.ts`（jose，HS256）：`issueToken({accountId, ttl})` / `verifyToken(token)`；secret 解析 `MEDIA_TRACK_JWT_SECRET` → `app_settings:jwt_secret`（加密注册表）→ 启动时生成。
- `POST /api/auth/token`：body `{ apiKey }` → 成功 200 `{ token, expiresIn, accountId }`；失败 401（**统一错误文案，不区分"key 错"与"未配"**，防枚举）；**限流**：复用 `lib/login-throttle.ts`（已存在）。
- 测试：round-trip、过期拒绝、篡改拒绝、错算法拒绝（`algorithms: ['HS256']` 显式）、限流。

### S5.4 全接口认证（F2 的主体，风险最高）
- `apps/web/lib/auth-chain.ts`：责任链 `resolveAccount(request)` = session cookie → Bearer JWT →（路由限定）worker secret / updater token。
- 白名单（**免登录**）：`/api/health`、`/api/auth/*`、`/api/workflows/run-next|run-type3`（走 secret）、`/api/update/hold|busy|status`（走 updater token）。
- 落地方式：**不在 middleware 硬拦**（Next 16 + cacheComponents 下 middleware 易踩静态渲染坑），改为每个需鉴权 route 顶部一行 `await requireApiAccount()`，由**架构门禁兜底**：新增 L2 规则"`app/api/**/route.ts` 出现 `export async function` 必须引用鉴权助手"（ESLint 正则或 dependency-cruiser），漏一个 CI 就红。
- 测试：每个路由一个"无凭据 → 401"用例（36 路由 × 1，参数化）；白名单路由断言免登录。

### S5.5 设置页 API Key 管理（F4）
- 新组件 `components/settings/api-key-section.tsx`（照 `TmdbApiKeySection`）：显示掩码 key + 来源徽标（DB/环境变量/未配置）+ 保存/轮换/清除按钮；来自 env 时禁用清除并提示"请改环境变量"。
- `POST /api/settings/api-key`（走 S5.4 鉴权）：写 DB；返回**一次性完整值**（仅创建/轮换时）。
- 测试：保存→掩码→来源切换 env→DB→清除 三态。

### S5.6 更新源改当前仓库（F5）
- `release-feed-server.ts`：`REPO` 改为 `process.env.MEDIA_TRACK_UPDATE_REPO ?? "<当前仓库>"`。
- 当前仓库取值：运行时从 `process.env.GIT_SHA` 不可行；**默认值用仓库自身 owner/name 常量**（随 fork 发布时由 Release Docker 的 `github.repository` 写入 build arg，见下）。
- **默认值即当前仓库**（`xixjohan/mediary-scout`，`DEFAULT_UPDATE_REPO`）。早先一版默认指向上游 `fancydirty/mediary-scout`，只有 Release Docker 烘焙过 `MEDIA_TRACK_UPDATE_REPO` 的镜像才指得对——源码直跑与本地 dev 全在检查别家的发布，与 F5「更新检查指向自己的仓库」不符（逐维核查实证的偏差，已修）。需要指回上游/别的 fork 时设 env。
- Dockerfile 增 `ARG UPDATE_REPO` / `ENV MEDIA_TRACK_UPDATE_REPO=$UPDATE_REPO`；`release-docker.yml` 传 `UPDATE_REPO=${{ github.repository }}`；compose 透传 `${MEDIA_TRACK_UPDATE_REPO:-}`。
- `updater/run-update.sh` 的 `IMAGE_BASE` 同步支持 `${MEDIA_IMAGE_BASE:-}` 推导（默认 `ghcr.io/${MEDIA_TRACK_UPDATE_REPO}`）。
- 测试：env 覆盖生效、默认值、部署文档同步。

---

## 6. 执行顺序与依赖

```
S5.1（横幅，独立） ─┐
S5.2（key 策略）  ─┼→ S5.3（JWT） → S5.4（全接口） → S5.5（设置页）
S5.6（更新源，独立）┘
```
S5.1 / S5.6 无依赖，可与 S5.2 并行；**S5.4 必须最后做**（它依赖 S5.3 的验证器，且一上线就影响全部接口）。

## 7. 验收总标准

> 数字随交付更新，不留在写作时的估计值上（逐维核查纠过的口径）：
> 路由总数 **40**（12 白名单 + 5 agent 自守卫 + 23 登录链）；全量测试
> **382 文件 / 5195 用例**；E2E 是 **1 个 spec 文件、4 个用例**（不是 4 个 spec）；
> jose 是 **v6**（`jwtVerify`/`SignJWT`，不是文档早期写的 jsonwebtoken）；
> 白名单「四类」按**机制**数（health / auth / worker-secret / updater-token），
> 路由数则是 12 个——`worker-secret` 管 run-next|run-type3、`updater-token` 管
> hold|busy|status（`status` 不换 token，但同属 updater 豁免族，见表下第 3 条验收）。

1. 每任务 TDD 红→绿；全量测试保持绿（当前基线 384 文件 / 5214 用例，第四轮复核后）。
2. 门禁全绿：`npm run gate`（layout + deps + `eslint . --max-warnings 0`）、
   **五处** typecheck（根 `npm run typecheck` 一棵树管住 shared/workflow/contracts，
   加 web / desktop / host-worker / tmdb-proxy 四处独立工程；tmdb-proxy 与
   scout-connect 各自另有 tsc，按需跑）、
   `build:shared` / `build:workflow` / `build:web`、`npm run e2e`。
   「gate」本身不含 typecheck，别把它当全量门禁。
3. F2 验收：40 路由逐一确认"无凭据 401 / 有 session 200 / 有 JWT 200"；白名单四类
   （health / auth / worker-secret 的 run-next|run-type3 / updater-token 的 hold|busy|status）
   确认免登录且原有机制仍工作（curl 实证：health POST→405 非 401、run-next→200、
   update/status POST→405 非 401；另用内置浏览器打开设置页看到 API Key section）。
4. F3 验收：四种优先级象限 + 落盘是密文 + 掩码不回显全值（curl 打真实服务，
   直读 SQLite 确认 `enc:v1:` 前缀且明文不在值里）。
5. F5 验收：本地起服务，更新检查指向**当前仓库**（`DEFAULT_UPDATE_REPO` 默认值
   即 `xixjohan/mediary-scout`，不再默认指向上游）。

## 8. 执行状态

| 任务 | 状态 | 说明 |
|---|---|---|
| S5.1 移除横幅 | ✅ | 删 `components/connect-notice-banner.tsx` + `app/page.tsx` 装配 + `connect-notice.ts` 的 dismissed key 逻辑与样式；相关测试改为断言"不再展示" |
| S5.2 API Key 策略+端口 | ✅ | `packages/shared/src/api-key-source.ts`（resolveApiKey DB>env>none 四象限 + maskApiKey）+ `packages/contracts` 的 IApiKeyStore 端口 + `api_key` 入 SECRET_SETTING_KEYS（AES-256-GCM 透明加密，实测落盘是 enc:v1: 密文、读回明文）。四象限 + 掩码 + SQLite 端口落盘单测全绿 |
| S5.3 JWT 颁发/验证 | ✅ | `packages/shared/src/auth/jwt.ts`（jose HS256，`algorithms` 显式拒降级）+ `POST /api/auth/token`：恒定时间比 key、复用登录限流、401 统一文案「api key 无效」（不区分未配/错 key，防枚举）；secret 走 env > `app_settings:jwt_secret`（加密，缺失自动生成 32 字节 hex）。round-trip/过期/篡改/错算法/限流单测全绿 |
| S5.4 全接口认证 | ✅ | `apps/web/lib/auth-chain.ts` 责任链（session cookie → Bearer JWT → 单用户局域网默认账号，远程 fail-closed）；22+1 个非白名单路由一行守卫；白名单机制原位不动（health / auth/* / run-next+run-type3 的 worker secret / hold+busy 的 updater token / status 的 owner session / agent/* 独立 token）。**两层兜底**：vitest 路由清单测试（40 路由逐一归类，新增路由必须显式表态）+ ESLint L2 新规则 `local/api-auth-required`（漏挂即 lint 红，白名单同源）。6 路由 × 3 凭据状态行为测试。修掉一个被 mock 掩盖的真 bug：workflow-runtime 只 import 未 re-export `DEFAULT_ACCOUNT_ID`，真实构建下 auth-chain 会炸 |
| S5.5 设置页管理 | ✅ | `GET/POST/DELETE /api/settings/api-key`（全过 S5.4 登录链；demo 403）+ `components/settings/api-key-section.tsx`（owner 门禁，落在「远程访问」tab）+ `components/api-key-panel.tsx`（掩码 + 来源徽标 db/env/none + 轮换返回**一次性完整值** + env 态禁清除并说明；后端 409 兜底）。三态读取/轮换/清除状态机 + 路由 14 用例 |
| S5.6 更新源改当前仓库 | ✅ | `updateRepoSlug()` env 可配 + 畸形值抛错；Dockerfile/workflow/compose/updater 全链透传；24/24 单测 + **干净实例实测 env 生效**（fork 无 tag → feed 为空，不再显示上游发布）；顺手清掉两个残留 next-server 进程 |

### 附：E2E 幂等性修复（S5.4 收尾时发现）

`e2e-run/mediary-e2e.db` 跨运行存活，「获取回路」spec 断言搜索「翘楚」后出现「获取」按钮——上一轮跑完该片名已进 `tracked_seasons`，按钮变「已追踪」，下一轮无改动也必红（实测复现）。修法：`e2e/reset-db.mjs` 由 `playwright.config.ts` 的 `webServer.command` 在 `next start` 前调用。**不能放 globalSetup**——Playwright 的任务顺序是「plugin setup（webServer 启动）→ globalSetup」，那时服务已打开并按 demo seed 写完库，再删会让运行中的服务对着被删的 inode 工作（实测两轮全红）。修后连续两轮 4/4 全绿。

### 附：交付前对抗性自审揪出的两个真缺口（S5.4/S5.5，均已修 + 实证）

1. **JWT 解出的账号被丢弃**：`auth-chain` 认 Bearer JWT，可 23 个路由守卫之后仍调 `getCurrentAccountId()` 取账号作用域——多用户模式无 session cookie 时它返回哨兵 `acct_unauthenticated`，「JWT 认证成功」与「拿不到账号」同时成立（账号数据全空、写路径抛错）。route-auth.test.ts 的 JWT 用例之所以绿，是它 mock 掉了 `getCurrentAccountId`（与 `DEFAULT_ACCOUNT_ID` 同一类掩盖）。修法：`resolveBearerAccountId()` 收归 `workflow-runtime` 一份实现，`auth-chain` 与 `getCurrentAccountId()` 共用；5 个真实模块级接线用例（有效/篡改/过期/错 secret/无凭据）。
2. **proxy 把 JWT 客户端弹去 /login**：起真实服务实测，单用户远程（cf-ray）+ 有效 JWT 打 `/api/activity` → **307 跳 /login**，S5.3 换来的 JWT 通道在外网（它的全部意义）整个失效。proxy 的豁免名单写于 S5.4 之前，只认 session cookie。修法：与 updater/worker 豁免同一理由——presence 粗筛放行带 `Authorization: Bearer` 的 `/api/` 请求，签名与过期交由路由的 `requireApiAccount()` 判；页面路径不放行（浏览器导航不带该头）。修后实测：远程+JWT 200、远程+无凭据仍 307、远程+篡改 JWT 401 JSON、局域网无凭据仍 200。

实证记录（真实服务 + 独立库，非 mock）：错 key → 401「api key 无效」（统一文案生效）；正确 key → 换得 JWT；`/api/settings/api-key` 落盘值实测为 `enc:v1:` 前缀密文、明文不在值里；设置页「远程访问」tab 的 API Key section：env 态徽标 + 仅「轮换」→ 点轮换后出现 64 位一次性完整值 + 徽标切「来自数据库」+ 「清除」按钮出现。

### 附：逐维核查（每维一个对抗性检查器）揪出的第二轮问题，均已修

六个维度并行核查（范围/非目标、认证正确性、密钥策略、失败模式、文档证据、全量门禁+真实服务实证），
判词 partial，揪出 5 个 medium + 一批 low。逐个红→绿修掉：

| # | 问题 | 修法 |
|---|---|---|
| M1 | `/api/settings/api-key` 只校验已登录、不校验 owner——多用户下任何普通账号能轮换/清除**实例级** key | 三个方法补 `resolveCurrentIsOwner()`；非 owner 一律 404（不泄露存在性）且不写库；demo 仍是 403，两者语义分开 |
| M2 | auth-chain 契约写「永不抛」，session 通道却裸调 `resolveSessionAccountId`——DB 抖动时路由 500，单用户 LAN 带 cookie 的请求被异常打死 | 通道 1 包 try/catch：读失败视同「这个通道没说话」，继续问 Bearer/局域网 |
| M3 | 两层兜底都是 `source.includes("requireApiAccount")`——留一行含该标识符的注释即可同时骗过 ESLint 规则与清单测试（RuleTester 探针实证） | 两层都改 **AST 判定**（真的有一次 CallExpression）；规则与清单测试各补「注释/字符串提及不算调用」用例 |
| M4 | 限流用例不自洽：固定发 5 次，单独跑（`-t` 过滤）时桶里没有前序用例烧的 4 次失败，第 5 次还没到阈值 → 断言 undefined；全量绿但单跑红 | 烧到真被锁为止 + 验证锁定持续；文件内加 `_resetLoginThrottleForTest()`，整文件顺序无关 |
| M5 | S5.6 默认更新源仍是**上游** `fancydirty/mediary-scout`——源码直跑与本地 dev 都在检查别家的发布，与 F5「指向自己的仓库」不符（S5.6 提交信息自己写明了这个取舍） | `DEFAULT_UPDATE_REPO` 改为 `xixjohan/mediary-scout`；env 仍可覆盖（含指回上游）；`.env.example`/文档同步 |
| M6 | 单用户模式下闸机会放过别账号的残留 session，而 `resolveSingleUserAccount` 明写单用户远程只认 `acct_default`——闸机放行、数据层 fail-closed，等于「认证通过的陌生人」 | 通道 1 与 `resolveSingleUserAccount` 完全同源：单用户 LAN 忽略 session（落到默认账号，开放语义不回归）、远程只认默认账号；两个既有用例的 mock 模式改成语义正确的多用户（断言一字未改） |
| L1 | 一批规格写了却无用例钉住的行为：demo 403、agent 404 映射、恒定时间比较不泄露长度、畸形 Bearer 只对 mock 复刻版断言、显式 key 无长度下限 | 全部补真实用例；另发现并统一 **Bearer scheme 大小写**（proxy 粗筛本就走 `/^bearer /i`，路由层却只认大写）；显式 key 加 16 位下限（拒绝把 1 字符设成长期凭据） |
| L2 | 死代码与门禁盲区：contracts 的 `IApiKeyStore` 与 shared 同形重复且零消费者、S5.1 声称删净的 dismissed key 仍在、两处 `void x;` 哑语句、顶层 `/api/route.ts` 不在两层门禁管辖内（该文件当前不存在，是**预防性**收口：glob 与规则正则都只匹配「至少一层目录」，真建一个就会两处同时漏） | 删掉 contracts 侧的重复定义（shared 保持唯一定义，contracts 恢复零依赖）；删死常量与哑语句（`rotateApiKey` 去掉没用到的 `env` 形参）；ESLint glob + 规则正则 + 单测都覆盖顶层路由 |
| L3 | 文档口径过期：路由数 36、e2e「4/4」易读成 4 个 spec、jose 版本、gate 只写「三处 typecheck」、F5 默认值 | §7 全部按交付事实改写，历史快照加标注 |

修复后门禁：vitest 382 文件 / 5195 用例、`npm run gate`、五处 tsc、三构建、e2e 1 文件 4 用例，全绿。

## 9. 需要用户确认的三个点

1. **白名单范围**：health/worker/updater 三类路由建议保持免登录（用各自现有机制）。若坚持"除登录外全拦"，healthcheck 与 worker 会坏——需要另行设计探针通道。
2. **API key 可否回显**：推荐"落库加密 + 只回显末 4 位 + 创建时展示一次"。若接受"不可回显"，可升级为单向哈希（更安全）。
3. **JWT 存活期**：默认 12h（env 可调）。自托管单实例也可选"长期"——但那就失去轮换意义。

### 附二：第三轮复核（修完再审）——修复本身引入的新问题

第二轮修完立刻再审一轮（修复也是新改动，不审等于没修）。又揪出 4 个，其中 1 个 high：

| # | 问题 | 修法 |
|---|---|---|
| H1 | **M5 把更新链拆成了两半**：网页 feed 默认源改成本仓库，可 `updater/run-update.sh` 仍默认上游、compose 的 updater 服务压根没透传 `MEDIA_TRACK_UPDATE_REPO`；更糟的是 compose 的 `MEDIA_TRACK_UPDATE_REPO: ${VAR:-}` 会恒设一个空串、把 Release Docker 烘焙进镜像的 `github.repository` 覆盖掉——默认部署去检查一个运营者从未选择的仓库。`scripts/deploy.sh` 又把上游镜像钉进 `.env` | 三处同源：updater 脚本、compose（updater 服务补透传；`MEDIA_TRACK_UPDATE_REPO: ${VAR:-}` 是 map 形式、**恒设**（可能为空串），空串在应用侧被视作未设并回落默认源——compose 没有「未设就不注入」的写法，烘焙值要靠镜像默认 env 或 .env 显式写同值来保留）、deploy.sh（镜像基址改由更新源推导）。补 4 个 updater 默认值用例钉住；后续几轮又补了 compose/deploy 两处推导的行为级测试（删掉不红） |
| H2 | L1 的 16 位下限在路由层没兜底：短 key 直接 500 空体，「至少 16 位」这条原因永远到不了调用方；顺带发现非字符串 `apiKey` 被静默丢弃、转而发一枚随机 key（调用方以为设了自己的值） | 路由层 try/catch 翻成 400；形状错误也 400。补 3 个用例 |
| H3 | M6 只对齐了 session 通道：单用户模式下 Bearer 通道仍放行**任意 sub** 的 JWT，与数据层「只认 acct_default」相反——当前 token 路由只签默认账号所以尚不可利用，但 per-account key 已写在它的规划里，而且上一轮的测试还把这条分歧断言成了「正确」 | 通道 2 与通道 1 同一裁决；补 4 个用例，改 2 个把分歧写成正确的旧用例 |
| H4 | 数据层单用户远程分支把 Bearer 判定包在 `sessionAccountId === null` 里：一枚能解析出别账号的残留 cookie 会让整个 Bearer 通道被跳过，持合法默认账号 JWT 的站主只拿到哨兵——200 空数据，而不是干净 401（真实 runtime 探针复现） | Bearer 改为无条件判定；用真实 `registerAccount`/`setSingleUserPassword` 造合法 cookie 做端到端用例（自引用 mock 拦不住模块内部调用，只会假装通过） |
| L4 | proxy 粗筛 `/^bearer /i` 比路由层的 `/^bearer (.+)$/i` 紧一个字符：`Bearer<tab>token` 会 proxy 307 拦死、路由根本看不到（大小写两处一致，但仓库里没有用例钉住）。桌面自更新的仓库写死上游，与网页 feed 的差异是静默的 | proxy 正则改 `\s`，补 4 个形态用例；桌面侧改 env 可覆盖（默认仍留上游安装包渠道——fork 不发 .dmg/.exe，改默认会让现有桌面安装收不到更新，那是另一种静默分歧），补 3 个用例 |
| L5 | `/api/auth/token` 只在失败时累计限流，成功不清桶：5 次误操作之后用正确 key 重试仍被锁到窗口过期 | 验签通过后 `recordLoginSuccess`；补 1 个用例验证「错 4 次 → 成功 → 再错 4 次不锁、第 5 次落锁」 |
| L6 | 白名单「各自机制仍在位」是文本 `toContain`——留一句注释就能让它绿；M1 的「401 先于 404」也无用例钉死（顺序反了信息泄露，但现有用例组合分不出来） | 机制判定改用同一个 `callsFunction`（AST）；补「无凭据 + 非 owner → 401」用例 |
| L7 | 上一轮给 contracts→shared 加了一条跨包依赖来消重复——那是弯折「契约层零依赖」换来的，而且这条新边对 L1 的 dependency-cruiser 门禁是不可见的（正则只匹配 packages/ 与 apps/） | 撤回依赖，改为**删掉** contracts 侧的重复定义：shared 保持唯一定义，contracts 恢复零依赖 |
| L8 | 文档口径：`update/status` 被归到「四个白名单路由」名下的 updater-token 族（实为 owner 门禁）；typecheck 名录写成「根/shared/workflow/contracts/web」（根 tsconfig 一棵树就管住后三者，独立工程是 web/desktop/host-worker/tmdb-proxy）；顶层 route.ts 写成「曾是盲区」（该文件从未存在，是预防性收口） | §7 按机制/路由两个口径分别写清；typecheck 按实际工程列；措辞改为预防性 |

第三轮修复后门禁同样全绿：382 文件 / 5195 用例、gate、五处 tsc、三构建、e2e 1 文件 4 用例。