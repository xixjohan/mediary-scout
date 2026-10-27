# API Key 认证 + 自包含更新 · 可行性与方案

> 任务单 **S5.1 ~ S5.5**（2026-10-27 起）。
> 输入：用户提出的 5 项需求 → 先头脑风暴（可行性/逻辑/性能/设计模式）→ 库与业界调研 → 落地方案 → 执行。
> 本文是该程序的唯一跟踪入口；执行状态见 §8。

---

## 1. 需求与现状基线

| # | 需求 | 现状（已代码踏勘） | 结论 |
|---|---|---|---|
| F1 | 去除「🎉 付费远程访问现已上线」横幅 | `apps/web/components/connect-notice-banner.tsx`，被 `app/page.tsx:109` 渲染；关闭态存 `app_settings`（`CONNECT_NOTICE_DISMISSED_KEY`） | **直接删组件+调用点+样式+server 条件**，零风险 |
| F2 | API key 登录换 JWT，所有接口加认证（登录除外） | 已有 HMAC 会话 cookie（`packages/workflow/src/auth/session.ts`，`timingSafeEqual` + `createHmac`）；`requireAuthenticatedAccountId()` 已存在于 workflow-runtime；**36 个 api 路由中约 1/3 无鉴权**（`agent/acquire`、`settings/attention`、`agent/*` 等） | 可行，但**必须先做一张"路由 × 鉴权"清单**，见 §3 |
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
- **HMAC 校验 O(1)、无 DB 查询**：session 设计与 JWT 验证都不查库（撤销靠短过期 + secret 轮换）。36 个路由每请求多一次 `createHmac`/`jwtVerify`，Web Crypto 的 HS256 验证约 **50–100µs**，相对现有 SQLite 查询（ms 级）可忽略。
- **jose 是 async API**（Web Crypto）：在 Next route handler 里 `await jwtVerify()` 无阻塞问题；但**不要放进 middleware 的热路径做多余工作**——middleware 只解析Bearer头、验签，业务账户解析留给路由内一次完成。
- **API key 解析每请求一次 DB 读**：`getSetting` 是 SQLite 点查（µs 级），但可加 30s 进程内缓存；key 变更后**最多 30s 生效**——这与"数据库优先"语义兼容（写后立即生效是更强的诉求，若用户要求，则去掉缓存，点查也足够快）。

### 2.4 设计模式落点（对齐本仓库现有模式）

| 模式 | 用在哪 | 与现状的衔接 |
|---|---|---|
| **策略模式** | `ApiKeySource` 策略：`EnvApiKeySource` / `DbApiKeySource` / `DisabledApiKeySource`，由 `resolveApiKey()` 按优先级选路 | 与 `createBrandPacer`、`StorageExecutor` 工厂同款；新文件 `packages/shared/src/auth/api-key-source.ts` |
| **适配器/端口** | `IApiKeyStore`（revoke/rotate/verifyMask）入 `packages/contracts`，SQLite 实现入 workflow 包 | `packages/contracts` 已有 4 个基础设施端口，直接扩展 |
| **责任链** | `Authenticator` 链：`SessionCookieAuthenticator` → `BearerJwtAuthenticator` → `WorkerSecretAuthenticator`（仅/workflows）→ `UpdaterTokenAuthenticator`（仅/update）→ 401 | 每个 authenticator 只回答"这是不是你管的凭据" |
| **状态机** | API key 生命周期 `absent → active → rotating(旧key宽限) → revoked` | 仓库已用 XState（acquisition-v2）。**评估后建议不用 XState**：状态仅 4 个且无并发补偿诉求，用 TS 判别式联合 + 纯函数更轻；若将来加"双 key 宽限期"再上 FSM。**明确记录此为有意识的取舍** |

---

## 3. 库调研与选型

| 库 | 许可 | 体积/依赖 | 运行时 | 结论 |
|---|---|---|---|---|
| **jose** v5 | MIT | 0 依赖，~100KB | Node/Edge/Workers（Web Crypto） | ✅ **选它**。RFC 7519 全套、Auth.js/Hono 内部都用它、`none` 算法默认拒绝 |
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
- `packages/shared/src/auth/api-key-source.ts`：`resolveApiKey(env, store)` → `{ value, origin: "db"\|"env"\|"none", masked }`，**DB 优先**；`mask` 只露末 4 位。
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

1. 每任务 TDD 红→绿；全量测试保持绿（当前基线 372 文件 / 5044 用例）。
2. `npm run gate` 三处 typecheck + 构建 + E2E 全过。
3. F2 验收：36 路由逐一确认"无凭据 401 / 有 session 200 / 有 JWT 200"；四个白名单路由确认免登录且仍工作（用内置浏览器 + curl 实证）。
4. F3 验收：四种优先级象限 + 落盘是密文 + 掩码不回显全值。
5. F5 验收：本地起服务，更新检查指向自己的仓库（curl release feed 实证）。

## 8. 执行状态

| 任务 | 状态 | 说明 |
|---|---|---|
| S5.1 移除横幅 | ✅ | 删 `components/connect-notice-banner.tsx` + `app/page.tsx` 装配 + `connect-notice.ts` 的 dismissed key 逻辑与样式；相关测试改为断言"不再展示" |
| S5.2 API Key 策略+端口 | ✅ | `packages/shared/src/api-key-source.ts`（resolveApiKey DB>env>none 四象限 + maskApiKey）+ `packages/contracts` 的 IApiKeyStore 端口 + `api_key` 入 SECRET_SETTING_KEYS（AES-256-GCM 透明加密，实测落盘是 enc:v1: 密文、读回明文）。四象限 + 掩码 + SQLite 端口落盘单测全绿 |
| S5.3 JWT 颁发/验证 | ✅ | `packages/shared/src/auth/jwt.ts`（jose HS256，`algorithms` 显式拒降级）+ `POST /api/auth/token`：恒定时间比 key、复用登录限流、401 统一文案「api key 无效」（不区分未配/错 key，防枚举）；secret 走 env > `app_settings:jwt_secret`（加密，缺失自动生成 32 字节 hex）。round-trip/过期/篡改/错算法/限流单测全绿 |
| S5.4 全接口认证 | ✅ | `apps/web/lib/auth-chain.ts` 责任链（session cookie → Bearer JWT → 单用户局域网默认账号，远程 fail-closed）；22+1 个非白名单路由一行守卫；白名单机制原位不动（health / auth/* / run-next+run-type3 的 worker secret / hold+busy 的 updater token / status 的 owner session / agent/* 独立 token）。**两层兜底**：vitest 路由清单测试（40 路由逐一归类，新增路由必须显式表态）+ ESLint L2 新规则 `local/api-auth-required`（漏挂即 lint 红，白名单同源）。6 路由 × 3 凭据状态行为测试。修掉一个被 mock 掩盖的真 bug：workflow-runtime 只 import 未 re-export `DEFAULT_ACCOUNT_ID`，真实构建下 auth-chain 会炸 |
| S5.5 设置页管理 | ✅ | `GET/POST/DELETE /api/settings/api-key`（全过 S5.4 登录链；demo 403）+ `components/settings/api-key-section.tsx`（owner 门禁，落在「远程访问」tab）+ `components/api-key-panel.tsx`（掩码 + 来源徽标 db/env/none + 轮换返回**一次性完整值** + env 态禁清除并说明；后端 409 兜底）。三态读取/轮换/清除状态机 + 路由 14 用例 |
| S5.6 更新源改当前仓库 | ✅ | `updateRepoSlug()` env 可配 + 畸形值抛错；Dockerfile/workflow/compose/updater 全链透传；21/21 单测 + **干净实例实测 env 生效**（fork 无 tag → feed 为空，不再显示上游发布）；顺手清掉两个残留 next-server 进程 |

### 附：E2E 幂等性修复（S5.4 收尾时发现）

`e2e-run/mediary-e2e.db` 跨运行存活，「获取回路」spec 断言搜索「翘楚」后出现「获取」按钮——上一轮跑完该片名已进 `tracked_seasons`，按钮变「已追踪」，下一轮无改动也必红（实测复现）。修法：`e2e/reset-db.mjs` 由 `playwright.config.ts` 的 `webServer.command` 在 `next start` 前调用。**不能放 globalSetup**——Playwright 的任务顺序是「plugin setup（webServer 启动）→ globalSetup」，那时服务已打开并按 demo seed 写完库，再删会让运行中的服务对着被删的 inode 工作（实测两轮全红）。修后连续两轮 4/4 全绿。

## 9. 需要用户确认的三个点

1. **白名单范围**：health/worker/updater 三类路由建议保持免登录（用各自现有机制）。若坚持"除登录外全拦"，healthcheck 与 worker 会坏——需要另行设计探针通道。
2. **API key 可否回显**：推荐"落库加密 + 只回显末 4 位 + 创建时展示一次"。若接受"不可回显"，可升级为单向哈希（更安全）。
3. **JWT 存活期**：默认 12h（env 可调）。自托管单实例也可选"长期"——但那就失去轮换意义。
