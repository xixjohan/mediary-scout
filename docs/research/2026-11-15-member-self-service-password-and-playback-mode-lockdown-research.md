# 成员自助改密 + 成员播放方式锁定的可行性与方案

日期：2026-11-15（Asia/Hong_Kong）。基线：`db01d623`（mediary 分支）。

> 新增研究稿。**不授权实施**，不做生产变更，不覆盖既有文档。

## 1. 两条需求

1. **允许用户修改自己的密码**（截图右上角是 `修改密码`，当前指向 `/settings?tab=account#password`）
2. **视频播放时普通用户不允许切换播放方式，只能使用影视库设置的方式播放**（截图中红框标出的 `切为302直连` 按钮）

## 2. 现状勘查

### 2.1 需求 1：改密功能**已存在**，但被上一轮的权限收敛锁死了

链路是完整的：

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 服务层 | [`changeOwnPassword()`](../../apps/web/features/auth/application/account-service.ts#L294) —— 校验当前密码 → 写新哈希 → **删除该账号全部 session** | 已实现 |
| Server Action | [`changePasswordAction()`](../../apps/web/app/actions/auth-actions.ts#L8) | 已实现 |
| UI 表单 | [password-change-form.tsx](../../apps/web/features/settings-system/components/password-change-form.tsx) | 已实现（当前密码 + 新密码） |
| 入口 | 个人资料弹窗 [`user-profile-modal.tsx:286`](../../apps/web/features/auth/components/user-profile-modal.tsx#L286) → `href="/settings?tab=account#password"` | 已实现 |

**但 `PasswordChangeForm` 挂在 `/settings` 页面里，而上一轮权限收敛把 `/settings` 对成员整页关闭了**：

```tsx
const verdict = decidePageAccess(access, "system:settings");
if (verdict !== "allow") return <PageAccessDenied required="system:settings" verdict={verdict} />;
```

于是成员点「修改密码」→ 落到 403 面板。**这不是缺功能，是我上一轮把已有的合法功能锁死了。** 这属于回退缺陷，不是新需求。

### 2.2 需求 2：播放方式有三条可选入口，且都绕开"影视库设置"

| 入口 | 位置 | 现状 |
| --- | --- | --- |
| 播放器 UI「切为302直连 / 切为代理模式」+ 账号级记忆 | [mediary-player-modal.tsx:144](../../apps/web/features/player/components/mediary-player-modal.tsx#L144) | 成员可点，偏好写进 `account_settings.player_delivery_mode` |
| 客户端 query 参数 `?delivery=proxy\|redirect` | [strm/play/route.ts:428](../../apps/web/app/api/strm/play/%5BtaskId%5D/%5BfileId%5D/route.ts#L428) | **优先尊重客户端**，可覆盖服务端配置 |
| 文件夹视图播放（不走 play 接口） | [library-folder-explorer.tsx:302](../../apps/web/features/library/components/library-folder-explorer.tsx#L302) | 只按 binding / 库默认算，不读账号偏好 |

「影视库设置的方式」在代码里对应什么？有三层，按优先级：

```
session（账号偏好/本次切换） > binding（路径绑定，非 inherit） > library（库默认）
  > global > 驱动约束（夸克/UC 强制代理等，一票否决）
```

所以「只能使用影视库设置的方式」的字面含义是：**砍掉 session 这一层**，让 `binding` / `library` 成为最高优先级，且**不允许客户端用 `?delivery=` 覆盖**。

## 3. 需求 1 的可行性与风险

### 3.1 结论：可行性高，工作量极小，但**有一个必须解决的入口问题**

改密逻辑本身不需要动。问题是「成员进不去 /settings」。三条修法：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）独立路由 `/account`** | 新建一个只含"个人资料 + 改密"的页面，成员可进，`system:settings` 不需要 | 新页面 + 一条侧边栏/头像菜单入口；`/settings` 保持对成员关闭 |
| B 在 `/settings` 开一个例外 | 页面判定改为「无 system:settings 但允许进 password 分区」 | 需拆分页面内分区权限，复杂度高，且容易漏（页面里还有 TMDB/代理/角色等配置） |
| C 弹窗内直接改密 | 把表单搬进个人资料弹窗，走 server action | 弹窗已有，最小改动；但与"个人资料页"信息架构不符 |

**方案 A 的逻辑优势**：`/settings` 是**实例配置面**（TMDB Key、代理、Prowlarr、角色、用户），`/account` 是**个人面**（我的资料、我的密码）。两者权限域本来就不同，混在一个页面上再用"例外"去区分，会让页面守卫的判定逻辑长出一堆分支。独立路由让「一个页面 = 一个权限域」这条不变量保持成立。

### 3.2 安全与逻辑风险

| 风险 | 说明 | 处置 |
| --- | --- | --- |
| **改密后全部 session 被删** | `changeOwnPassword` 调 `deleteSessionsForAccount` | 这是**刻意**行为（改密即踢下所有设备）。UI 已提示"正在跳转登录页"。但要确认：成员改密后**站长不会被踢**（删除是按 accountId 的，不会误伤）。已核实：`deleteSessionsForAccount(accountId)` 只删自己的。 |
| **首次设密可留空当前密码** | `changeOwnPassword` 在 `passwordHash` 为空时跳过校验 | 成员账号由站长创建时必带初始密码，因此**成员永远走"必须校验当前密码"分支**。但 `isFirstPassword` 这条分支在多用户模式下是**危险的**：若某账号密码被清空（例如站长手工清库），任何持有该 session 的人都能直接设新密码。建议：多用户模式下要求 `isFirstPassword` 必须伴随当前 session 由 owner 授予（或直接禁用该分支）。 |
| **无改密限流** | 登录有 [`checkLoginAllowed`](../../apps/web/features/auth/core/login-throttle.ts#L52)（5 次/15 分钟），改密**没有** | 攻击者拿到 session 后可无限次猜「当前密码」？其实拿到 session 已等于完全控制账号，改密不是提权。但**枚举当前密码**没有意义，可不加。若要加，复用同一个 throttle 桶即可（成本极低）。 |
| **NIST 口径** | 不强制定期改密；允许自助改密但必须验证身份；长度 ≥ 8 更现代 | 当前 6 位下限偏松，且无强度提示。建议提到 8 位（NIST 800-63B 的最低要求）并给出可读提示。**这会改变现有契约**，需明确是否接受。 |
| **改密后 API Key 是否失效** | 现在只删 session，不碰 API Key | 若成员持有一枚 API Key，改密后 Key 仍有效。安全版本号（`security_version`）机制存在但改密没 bump 它。**这是真实缺口**：改密应当 bump 安全版本号，让所有派生 Key 一并失效——否则"改密"给人一种虚假的安全感。 |

### 3.3 性能

改密是 **O(1) 次哈希 + 1 次 UPDATE + 1 次 session 批量删除**。scrypt 是故意慢的（~50-100ms），属预期成本。无性能顾虑。

## 4. 需求 2 的可行性与风险

### 4.1 核心设计取舍：**锁定的是"层"还是"值"**

两种语义完全不同，必须先定：

| 语义 | 含义 | 实现 | 风险 |
| --- | --- | --- | --- |
| **锁层**（推荐） | 砍掉 session override；binding/library 照常生效 | 成员不再读 `player_delivery_mode`，UI 不渲染切换按钮，服务端忽略 `?delivery=` | 库设置的 binding 若为 `redirect`，成员仍走 302——**字面符合"用影视库设置的方式"** |
| 锁值 | 强制所有成员走某个固定模式（如全 proxy） | 需要新增"成员强制策略"配置项 | 与用户上一轮"强制代理不做"的决策冲突（决策 3），且带宽成本极高 |

**采用锁层**：它就是用户原话「只能使用影视库设置方式播放」的无损实现。

### 4.2 现状的三条绕过路径必须同时关掉

只关 UI 按钮是**无效的**（本项目已有先例：库管理组件直接 fetch，藏按钮毫无作用）：

| 绕过 | 现状 | 修法 |
| --- | --- | --- |
| 播放器切换按钮 | 成员可点，写账号偏好 | 按权限/角色不渲染；服务端**同时**不读该偏好 |
| `account_settings.player_delivery_mode` | 成员此前可能已写入 | 读取侧按角色跳过（历史值不必清理，直接不生效） |
| `?delivery=redirect` | 播放路由优先尊重客户端 | 无 `storage:browse_any`（或新增 play-policy 权限）时忽略该参数 |

### 4.3 数据来源分层（这里有一个真实缺口）

三条播放入口的"影视库设置"来源**不一致**：

- `/api/library/play` 读 **binding → library → global**（完整责任链）→ 正确
- `library-folder-explorer` 只读 **binding → library 默认**（`defaultDeliveryMode` prop）→ 缺 global，且**不读账号偏好**（对成员恰好是正确行为）
- `strm/play` 读 **strm task 的 deliveryMode** → 与影视库设置**无关**

**缺口**：STRM 播放（外部播放器/SRT 客户端的 `.strm` 文件）走的是 STRM 任务的投送配置，**不是影视库设置**。要让需求 2 覆盖 STRM，就需要把 STRM 任务的投送模式也纳入影视库/绑定配置，或明确"需求 2 只管理应用内播放器"。

**这是必须让用户确认的边界**（见 §8 第 2 项）。

### 4.4 设计模式落点

| 模式 | 现状 | 本轮用法 |
| --- | --- | --- |
| **策略/责任链** | `resolveDeliveryMode` 已是责任链（4 层 + 驱动约束） | **复用**：加一个 `sessionOverride` 的**准入闸**（谁能提供 session 层），不动链本身 |
| **适配器** | `buildPlayStreamUrls` / 三处播放入口的组装逻辑各自实现 | 可考虑统一为「投送上下文适配器」，但**本轮不做**——三处行为差异（文件夹视图不读偏好）是刻意的 |
| **状态机** | 播放器有 `currentMode` + `rememberedModeRef` + `overrideActive` + `preferenceReset` 四个并行的布尔/引用 | **本轮建议收敛**：这四个标志实际表达的是"投送模式处于哪个状态"（跟随策略 / 用户临时覆盖 / 用户已记忆偏好 / 已重置）。它是一个**小型 FSM**：`follow-policy → overridden → remembered → follow-policy`。现在是 4 个互相纠缠的状态位，加"成员不可切换"会变成 5 个，风险陡增。建议在动需求 2 之前，把这个状态收敛成显式 FSM（纯函数 + 表驱动测试）。 |

### 4.5 性能

投送模式是**纯内存判定**，零 I/O。锁定它不带来任何性能成本。
反过来说，若将来要做"成员强制代理"，**服务器出口带宽**会成为真实成本（上一轮已论证）。

## 5. 业界对照

| 方案 | 做法 | 可借鉴 |
| --- | --- | --- |
| **Jellyfin** | 每用户可单独开关「允许转码 / 允许直连」，播放器据此限制选项 | 与需求 2 最接近：**按用户能力位限制播放选项**，而非按库 |
| **Plex** | 服务端可限制自动质量的上限位率，但"直连 vs 转码"主要由客户端决定 | 说明"完全由服务端强制"在流媒体里是**少数派**——多数产品选择"限制选项"而非"锁死" |
| **Emby**（社区讨论） | 用户多次要求"站长强制某用户的画质/直连设置"，官方明确**画质是 per-app 设置、不是 per-user** | 反面证据：per-app 设置无法被服务端强制，用户会反复提需求。我们若做，必须**服务端裁决**而非只改 UI |
| **NIST SP 800-63B** | 允许自助改密，但要求验证身份；不强制定期轮换；最小长度 8 | 需求 1 应遵循：校验当前密码（已实现）、不强制轮换、长度提到 8 |

## 6. 现有基础设施复用清单（零新增依赖）

| 需求 | 可复用 | 位置 |
| --- | --- | --- |
| 改密 | `changeOwnPassword` / `PasswordChangeForm` / `changePasswordAction` / 登录限流器 | 全部已存在 |
| 改密后失效 | `deleteSessionsForAccount` + `bumpUserSecurityVersion`（**尚未接到改密路径**） | [account-service.ts](../../apps/web/features/auth/application/account-service.ts) / [user-management-service.ts](../../packages/workflow/src/auth/user-management-service.ts#L58) |
| 播放锁定 | `resolveDeliveryMode` 责任链、`generateEffectiveDeliveryMode` 驱动约束 | [delivery-mode-resolver.ts](../../packages/workflow/src/strm/delivery-mode-resolver.ts) |
| 权限判定 | `hasPermission` / `requirePermission` / 权限目录 | 上一轮已建 |
| 页面权限 | `decidePageAccess` / `PageAccessDenied` | 上一轮已建 |

**结论：两条需求都不需要任何新依赖。** 改密功能主体已存在（只是被锁死）；播放锁定只需在既有责任链上加一个准入闸 + 三个入口一致化。

## 7. 分阶段实施建议

**P0（回退修复：让成员能改密）**
1. 新建 `/account` 个人页（资料 + 改密表单），成员可进；`/settings` 保持对成员关闭
2. 个人资料弹窗的「修改密码」指向 `/account`
3. 改密后 **bump `security_version`**，让派生 API Key 一并失效（当前只删 session，是个假安全感）
4. 密码下限 6 → 8（需用户确认，见 §8）

**P1（播放方式锁定）**
1. 先收敛播放器交付状态（4 个并行标志 → 显式 FSM），**再做锁定**
2. 成员：不渲染切换按钮 / 不渲染「恢复默认」
3. 服务端：非 `storage:browse_any` 账号忽略 `?delivery=` 且不读 `account_settings.player_delivery_mode`
4. 文件夹视图入口与 `/api/library/play` 的投送来源对齐（补 global 层）

**P2（可选，需单独决策）**
- STRM 播放是否纳入（涉及 STRM 任务配置与影视库配置的合并）
- 改密限流（复用登录桶）

## 8. 待确认（实施前必须定）

1. **改密入口**：独立 `/account` 页（推荐）／弹窗内直接改／`/settings` 开例外？
2. **需求 2 的覆盖范围**：只管应用内播放器（库详情 + 文件夹视图），还是**也管 STRM**（外部播放器读 `.strm` 文件）？后者需要把 STRM 任务投送配置合并进影视库配置。
3. **密码下限**：保持 6 位，还是提到 NIST 建议的 8 位？（提到 8 位是对现有契约的破坏性变更）
4. **锁定粒度**：锁"层"（砍 session，binding/library 照常用——推荐）还是锁"值"（强制统一某种模式）？

## 9. 参考来源

检索与核对日期：2026-11-15。

- [S1 Jellyfin — Managing Users](https://jellyfin.org/docs/general/server/users/adding-managing-users/)：每用户可配置项（含播放/转码能力位）。
- [S2 Jellyfin — Transcoding](https://jellyfin.org/docs/general/post-install/transcoding/)：Direct Play / Remux / Transcode 的区别与服务器负载含义。
- [S3 Jellyfin Desktop #687](https://github.com/jellyfin/jellyfin-desktop/issues/687)：用户关闭转码后仍被转码的实测案例——客户端与服务端策略不一致会互相打脸。
- [S4 Emby 社区：允许站长改用户画质设置](https://emby.media/community/topic/136784-allow-emby-server-owners-to-change-users-quality-settings/)：官方说明「画质是 per-app 设置，不是 per-user」，说明"服务端强制"需要显式设计。
- [S5 Emby 社区：画质选择被禁用时的播放行为](https://emby.media/community/topic/144330-question-about-playback-when-quality-selection-is-disabled/)：禁用选项后仍能直连的边界情况。
- [S6 Plex — 自动调整画质](https://support.plex.tv/articles/115007570148-automatically-adjust-quality-when-streaming/)：服务端可按位率上限约束客户端自动画质。
- [S7 NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)：自助改密需验证身份、不强制定期轮换、最小长度 8。
- [S8 NIST 密码指南解读（Netwrix）](https://netwrix.com/en/resources/blog/nist-password-guidelines/)：长度优先于复杂度、避免定期强制改密。

本地设施核对（基线 `db01d623`）：[changeOwnPassword](../../apps/web/features/auth/application/account-service.ts#L294)、[PasswordChangeForm](../../apps/web/features/settings-system/components/password-change-form.tsx)、[改密 action](../../apps/web/app/actions/auth-actions.ts#L8)、[登录限流](../../apps/web/features/auth/core/login-throttle.ts#L52)、[投送责任链](../../packages/workflow/src/strm/delivery-mode-resolver.ts)、[投送偏好键](../../packages/workflow/src/strm/player-delivery-preference.ts#L14)、[播放器切换](../../apps/web/features/player/components/mediary-player-modal.tsx#L144)、[播放路由 delivery 参数](../../apps/web/app/api/strm/play/%5BtaskId%5D/%5BfileId%5D/route.ts#L428)、[文件夹视图投送](../../apps/web/features/library/components/library-folder-explorer.tsx#L302)、[页面权限守卫](../../apps/web/platform/next-context/page-permission-guard.ts)、[设置页守卫](../../apps/web/app/settings/page.tsx)、[安全版本号](../../packages/workflow/src/auth/user-management-service.ts#L58)。

## 10. 实施记录（2026-11-15，按四条决策落地）

### 10.1 决策

| # | 决策 | 落点 |
| --- | --- | --- |
| 1 | 独立 `/account` 页 | 新建页面；`/settings` 保持对成员关闭；改密分区从 settings 移除 |
| 2 | 只管应用内播放器 | STRM 路由的 `?delivery=` 也按同一把钥匙收口（见 10.4 的说明） |
| 3 | 保持 6 位 | 未改密码下限 |
| 4 | 锁「层」 | 不读 session 覆盖、不尊重 `?delivery=`；binding/library 照常 |

### 10.2 P0：自助改密

- 新建 [account/page.tsx](../../apps/web/app/account/page.tsx)：个人资料 + 改密 + 安全说明。**不做权限判定**（登录即可），真正的校验在服务端。
- `accountPasswordHref()` 与远程访问区块、个人资料弹窗的入口全部改向 `/account`；`/settings` 的重复改密分区删除（同一功能不留两个入口）。
- `changeOwnPassword` 补两处：
  1. **多用户模式下禁止「首次设密免校验」**——原分支对多用户是提权口子（拿到 session 即可覆盖密码）。成员账号由站长创建时必带初始密码，该分支只对单用户首次设密有意义。
  2. **bump `security_version`**，让已签发的 API Key 一并失效。此前只删 session，是"改了密码但旧 Key 还能用"的假安全感。

### 10.3 P1：播放器投送状态收敛 + 成员锁定

**状态机先行**（这是本次唯一的设计模式落点，且不引入任何库）：

新 [delivery-control-fsm.ts](../../apps/web/features/player/core/delivery-control-fsm.ts) 把原来的 4 个并行标志（`currentMode` / `rememberedModeRef` / `overrideActive` / `preferenceReset`）收敛为两个维度：

- `mode`：当前实际使用的投送方式
- `origin`：`policy`（跟随影视库设置）｜`user`（用户显式选择）

三条不变量（旧实现无法穷举测试，现在可以）：
1. `policy` 态：服务端裁决永远优先；
2. `user` 态：服务端裁决不得覆盖用户选择；
3. `locked`：任何事件都不得把 `origin` 变成 `user`。

副作用（写/清账号偏好）由状态机通过 `effect` 返回、调用方执行——保持 reducer 纯净。

**成员锁定**：

| 层 | 机制 | 位置 |
| --- | --- | --- |
| UI | 不渲染切换 / 恢复按钮；不读账号偏好 | [mediary-player-modal.tsx](../../apps/web/features/player/components/mediary-player-modal.tsx) + `modeLocked` prop |
| 服务端（库播放） | 非 `storage:browse_any` 不读 `account_settings.player_delivery_mode` | [library/play route](../../apps/web/app/api/library/play/%5BepisodeId%5D/route.ts) |
| 服务端（STRM 播放） | 非 `storage:browse_any` 忽略 `?delivery=` | [strm/play route](../../apps/web/app/api/strm/play/%5BtaskId%5D/%5BfileId%5D/route.ts) 的 `resolveConfiguredDelivery` |
| 写入面 | 被锁定账号写偏好直接返回 false | [player-delivery-actions.ts](../../apps/web/app/actions/player-delivery-actions.ts) |

判据统一为 [playback-mode-policy.ts](../../apps/web/lib/playback-mode-policy.ts) 一把钥匙（`storage:browse_any`），不按角色名硬编码。

### 10.4 一个顺带修掉的真实缺陷

文件夹视图播放器的投送计算原来是「binding 非 inherit 则用 binding，否则用库默认」的**两段式**，漏掉了驱动物理约束：绑定配成 `redirect` 的夸克盘会发起必然失败的直连。现在改为与 `/api/library/play` **同一个责任链**（`resolveDeliveryMode`），补上 provider 约束。

### 10.5 验证证据

- `npm run gate` exit 0；`apps/web` + `packages` **539 文件 / 6221 测试通过**。
- 红绿验证三处：改密不 bump 安全版本号 → 测试红；`isPlaybackModeLocked` 直通 → 3 用例红；清单权限点写错 → 门禁红（上一轮）。
- 新增测试：FSM 19 用例（含 5 条 locked）、播放策略 8 用例、自助改密 4 用例。

### 10.6 Dev 实机验收

| 检查项 | 账号 | 实测 |
| --- | --- | --- |
| `/account` 页面 | 站长 | 正常；个人资料/修改密码/安全说明三块齐全 |
| `/account` 页面 | 成员 | **正常进入**（此前点「修改密码」会落到 `/settings` 的 403） |
| `POST /api/auth/password` | 成员 | 400「多用户模式请在账号设置中改密」（单用户专用路由仍被正确隔离） |
| `/api/library/play/{ep}` | 成员 | `deliveryMode=proxy`, `deliverySource=library` —— **来源是 library 而非 session** |
| 成员库里预置 `player_delivery_mode=redirect` | 成员 | 播放仍为 `proxy`/`library`：**历史偏好被正确忽略** |
| 侧边栏 | 成员 | 只剩 搜索/订阅/影视库/通知/活动 |

> 注：成员"UI 不渲染切换按钮"这条只能通过组件语义确认（`modeLocked` → `canOfferModeSwitch` 返回全 false，已有 5 条 locked 用例覆盖）。内置浏览器在此期间无可见视口（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），截图不可用，故未留视觉证据。
