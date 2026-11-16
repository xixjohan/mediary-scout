# 成员改密落到 403：入口可达性缺陷的根因与门禁

- 日期：2026-11-16
- 状态：已实施（含 3 道回归门禁）
- 触发现象：Dev 实例（`192.168.1.100:3020`）成员点侧边栏「修改密码」→ 落到
  `/settings?tab=account#password`，页面显示「权限不足 / 所需权限：system:settings」。
- 前置文档：[2026-11-15-member-self-service-password-and-playback-mode-lockdown-research.md](./2026-11-15-member-self-service-password-and-playback-mode-lockdown-research.md)、
  [2026-11-15-member-role-access-scope-and-proxy-only-playback-research.md](./2026-11-15-member-role-access-scope-and-proxy-only-playback-research.md)

---

## 1. 结论先行

**不是 `/account` 页有问题，也不是权限判定错了；是「链接」这一层从未被纳入契约。**

上一轮把改密从 `/settings` 迁到独立 `/account` 时，改了**四处入口**里的三处：
个人资料弹窗、远程访问区块、`accountPasswordHref()`。漏掉的那一处是侧边栏账号菜单
[`account-identity.tsx`](../../apps/web/features/auth/components/account-identity.tsx) ——
它的 href 是**手写模板字符串拼接**：

```ts
const accountHref = (hash: string) =>
  `/settings?tab=account${storageId ? `&w=${encodeURIComponent(storageId)}` : ""}${hash}`;
```

而 `/settings` 在本轮权限收敛中被**整体**关给成员（`decidePageAccess(access, "system:settings")`）。
于是「所有角色都看得见的组件」+「只有站长能进的 URL」= 成员必然吃到 403。
提交 `0004d36c` 的文件清单里根本没有 `account-identity.tsx`（`git show --name-only` 为 0 命中），
这就是漏改的机械证据。

`/account` 页本身是对的：它不做权限判定、`changeOwnPassword` 校验当前密码、改后删 session
并 bump `security_version`。Dev 上直接访问 `/account#password` 一直是可用的。

### 1.1 三条同源缺陷（同一类，同一轮修复）

顺着「可见 ≠ 可达」这条线，又查出三处同样形态的问题：

| # | 位置 | 缺陷 | 影响 |
| --- | --- | --- | --- |
| A | 侧边栏账号菜单 | 改密链接指向 `/settings?tab=account` | 成员 403（本次报告的现象） |
| B | [`settings/mediaserver/page.tsx`](../../apps/web/app/settings/mediaserver/page.tsx)、[`settings/extensions/page.tsx`](../../apps/web/app/settings/extensions/page.tsx) | 只包了 `PageLoginGuard`（登录即可），**没有** `system:settings` 判定 | 成员手输 URL 就能进配置面（媒体服务器 token、扩展代码执行） |
| C | 空状态卡片、「助理」页 | 无条件渲染 `/settings` `/storage` `/chat` 死链；`/chat` 只有 `PageLoginGuard` | 成员在最需要指路时被送进 403；`/chat` 与其 API 均无能力点 |

B 是**安全面**问题（不是体验问题）：页面级关停对 `app/settings/**` 只覆盖了根页面。
C 里 `/chat` 更值得警惕——助理会读网盘与库上下文，属 `assistant:chat` 能力，成员角色刻意不含该点
（见 2026-11-15 决策 1 的允许列表），但页面与 `/api/chat*` 三个路由过去都只要求「登录」。

---

## 2. 根因分析：为什么这类缺陷不可能被现有测试发现

现有的授权测试覆盖了三层：

1. **判定纯函数**：`decidePageAccess` / `hasPermission`（表驱动，全组合覆盖）；
2. **接线**：`page-auth-inventory.test.ts` 断言每个 `page.tsx` 引用了 `PageLoginGuard` 且在 Suspense 内；
3. **API 清单**：`route-auth-inventory.test.ts` + `ROUTE_PERMISSION_TABLE` 断言每个端点真的调了
   `requirePermission(声明的权限点)`。

三层全绿，缺陷照旧存在。因为错的东西在**第四层**：从「某角色可见的组件」到「受权限约束的 URL」
之间那条隐式契约。它的形态是：

> 一个只在部分角色可用的 URL，被一个**所有角色都能看到**的组件硬编码渲染。

任何一层都没在问这个问题。判定函数是对的、页面守卫是对的、组件渲染也是对的——
只有它们之间的**拼接**是错的，而拼接过去是自由文本。

第二个结构性原因：`app/settings/**` 的守卫是**按页面逐个复制**的，没有「配置面子树整体归谁」的声明。
根页面加了钥匙，子页面照抄了 `PageLoginGuard` 就以为齐了。这是复制粘贴式守卫的必然结果。

第三：侧边栏隐藏入口被当成关闭。`nav-visibility.ts` 的注释自己写着「**这不是访问控制**」——
但同一份代码把「入口是否渲染」与「URL 是否可达」当成同一件事，这就是 bug 的温床。

---

## 3. 现有库 / 基础设施复用核查

**结论：零新增依赖。** 所需的三块能力本仓库全部已有：

| 能力 | 现有设施 | 复用方式 |
| --- | --- | --- |
| 权限判定 | `resolvePageAccess()` / `decidePageAccess()`（[`page-permission-guard.ts`](../../apps/web/platform/next-context/page-permission-guard.ts)） | 子页面直接调用，判据与根页面同一把钥匙 |
| 能力点清单 | `PERMISSION_CATALOG` + `BUILTIN_ROLES`（`@media-track/shared`） | `assistant:chat` / `system:settings` / `storage:browse_any` 均已存在，无需新增权限点 |
| 路由权限表 | `ROUTE_PERMISSION_TABLE` + `WIRED_ROUTE_COUNT`（[`route-permission-table.ts`](../../apps/web/platform/next-context/route-permission-table.ts)） | `chat` / `chat/conversations` / `chat/conversations/[id]` 三条登记进表 |
| 静态源码扫描（AST） | `typescript` devDependency（已用于两个 inventory 门禁） | 新门禁复用 `ts.createSourceFile` 走查字符串字面量 |
| 客户端权限读取 | `useAuth().can(permission)`（[`auth-context.tsx`](../../apps/web/features/auth/components/auth-context.tsx)） | 空状态卡片按真实可达性渲染 CTA |

不引入 Casbin / Oso / SpiceDB：它们解决的是**策略表达**（多租户、动态策略、ReBAC），
本项目的策略已经是「角色 → 静态权限点集合」的固定形状，缺的只是**执行覆盖面**，
不是表达力。引入策略引擎会把 40 行声明表换成一套 DSL + 加载器，收益为负。

---

## 4. 业界方案对比

### 4.1 主流的「个人面 / 管理面」分离（对齐验证）

| 产品 | 个人面 | 管理面 | 说明 |
| --- | --- | --- | --- |
| Jellyfin | 用户菜单 → *Profile / My Preferences* | Dashboard → *Users / Libraries* | 普通用户永远看得见个人菜单；Dashboard 仅管理员（[S1]） |
| Plex | Account 设置 | Server 设置（仅 server owner） | 两套入口物理分离（[S2]） |
| Emby | 用户菜单偏好 | Server Dashboard | 画质是 per-app 设置，不是 per-user（[S3]） |

**对齐结论**：本站把改密迁到独立 `/account` 与三家一致；不一致的只有「入口指向」——
这正是本次修的。业界不靠「藏入口」，靠「两套入口各自指向自己的页面」。

### 4.2 「入口可达性」这条不变量在业界怎么被守住

- **路由集中声明 + 生成导航**（Django `admin` 的 `get_urls()`、Rails 的 `routes.rb` + `current_user` 过滤）：
  链接不手写，从「我有权访问的路由表」生成。本项目对应做法就是把两个 URL 收敛成两个具名构造器。
- **Deny by default**（OWASP Authorization Cheat Sheet / OWASP Top 10 A01）：默认拒绝，逐请求校验；
  并且「集中执行点」优于散落的逐页复制（[S4][S5]）。本项目对应做法是子页面树整体归 `system:settings`。
- **Middleware 不作为授权边界**（Next.js 官方 + CVE-2025-29927）：`proxy.ts` 只做 presence 粗筛，
  权威判定在页面/路由内（[S6][S7]）。本项目已经遵守，本次没有把新判定放进 proxy。

### 4.3 为什么不做「自动从权限集合生成导航」的完整重构

Django/Rails 那套的前提是**路由集中声明**（一份 routes 文件），而本项目是文件系统路由
（`app/**/page.tsx`）——没有可供生成的中枢。要做得先造一张「页面 → 权限点」表，
这正是本次门禁做的事（`app/settings/**` 子树断言），比引入生成器便宜得多。
按「不做超出任务范围的抽象」的原则，只在**出错的地方**加声明，不改路由架构。

---

## 5. 解决方案

### 5.1 单一构造器：把隐式 URL 契约变成类型化的显式契约

新增 [`account-links.ts`](../../apps/web/features/auth/core/account-links.ts)：

```ts
export const ACCOUNT_SELF_SERVICE_PATH = "/account";       // 个人面：登录即可
export const ACCOUNT_ADMIN_PATH = "/settings?tab=account"; // 实例配置面：system:settings

export function accountSelfServiceHref(opts?): string;  // 恒 /account
export function accountAdminHref(opts?): string;        // 恒 /settings?tab=account
```

`?w` 与 `#hash` 的编码收口在内部（用 `URLSearchParams`，与既有 deep-link 约定一致：
空格 → `+`）。四处入口全部改为调用构造器：

| 入口 | 文件 | 用哪个构造器 |
| --- | --- | --- |
| 侧边栏「修改密码」 | `account-identity.tsx` | `accountSelfServiceHref` |
| 侧边栏「账号管理」（仅站长渲染） | `account-identity.tsx` | `accountAdminHref` |
| 个人资料弹窗「修改密码」 | `user-profile-modal.tsx` | `accountSelfServiceHref` |
| 远程访问「修改个人登录密码」 | `remote-access-section.tsx` | `accountSelfServiceHref` |
| 远程访问「管理系统用户」 | `remote-access-section.tsx` | `accountAdminHref` |
| `accountPasswordHref()` | `settings-system/core/remote-access.ts` | 委托给 `accountSelfServiceHref` |

同时 `settings-tabs-model.ts` 的 legacy 锚点集合移除 `#password`：`/settings` 里已经没有该锚点，
继续映射会把人送到空气。

### 5.2 配置面子树整体归 `system:settings`

`/settings/mediaserver`、`/settings/extensions` 补上与根页面相同的判定：

```ts
const verdict = decidePageAccess(await resolvePageAccess(), "system:settings");
if (verdict !== "allow") return <PageAccessDenied required="system:settings" verdict={verdict} />;
```

不 redirect：用户确实登录了，只是这个页面不给他。`/settings/extensions` 尤其重要——
扩展可以加载任意代码，它的 API 过去也只有「登录」。

### 5.3 助理（`/chat`）按能力点收口

- 页面：[`app/chat/page.tsx`](../../apps/web/app/chat/page.tsx) 断言 `assistant:chat`；
- API：`/api/chat`、`/api/chat/conversations`、`/api/chat/conversations/[id]` 从
  `requireApiAccount` 换成 `requirePermission(request, "assistant:chat")`，
  并登记进 `ROUTE_PERMISSION_TABLE`（`WIRED_ROUTE_COUNT` 37 → 40）。

成员角色不含该点（2026-11-15 决策 1 的允许列表），因此侧边栏隐藏 + 手输 403 + API 403 三层一致。

### 5.4 空状态 CTA 按真实可达性渲染

`ResourceEmptyDiagnostic` 新增 `canOpenSettings` / `canBrowseStorage`（默认 `true`，保持站长行为不变），
由 [`title-resource-panel.tsx`](../../apps/web/features/acquisition/components/title-resource-panel.tsx)
用 `useAuth().can("system:settings")` / `can("storage:browse_any")` 注入（与页面守卫同一把钥匙）。
成员看到的是「检索源由站长维护，请稍后重试或联系站长」，而不是一个点了就 403 的按钮。

---

## 6. 门禁：让同类缺陷不可能再回来

三道门禁，分别守三层。

### 6.1 `gated-link-reachability.test.ts`（新增，守**入口**）

`apps/web/tests/unit/auth/gated-link-reachability.test.ts`，7 个断言：

1. 扫描到的源码文件数 > 200（防止目录扫空导致门禁静默失效）；
2. **`/settings?tab=account` 与 `#password` 组合不得出现在 `account-links.ts` /
   `settings-tabs-model.ts` 之外**——这正是漏改那个 href 的形态；
3. `/account#` 字面量同理；
4. 个人面构造器恒以 `/account` 开头、**永不含 `/settings`**；
5. 配置面构造器恒以 `/settings?tab=account` 开头；
6. `?w` 与 `#hash` 的编码/规范化正确（空格→`+`，`&`/`/` 转义）；
7. 两个构造器的产出前缀互斥（「同一功能不留两个入口」的物理保证）。

**关键实现细节**：扫的是 **AST 里的字符串字面量与模板串内容**，不是全文文本。
与 `/api` 侧 `route-auth-inventory` 同一教训的反向应用——注释里写「旧链接是
`/settings?tab=account`」是有价值的文档，不该判红；真正渲染给用户的 href 一定在字符串里。
（第一版用全文正则，结果被自己刚写的那句注释判红，说明这个设计是必要的。）

**红→绿实证**：把 `account-identity.tsx` 改回原来的模板拼接，门禁立刻报
`features/auth/components/account-identity.tsx`；恢复构造器后转绿。

### 6.2 `page-auth-inventory.test.ts`（扩展，守**页面子树**）

新增断言：`app/settings/**` 的每个 `page.tsx` 都必须出现
`decidePageAccess` + `"system:settings"`。页数下限 `>= 3`，防止子树被悄悄清空。

**红→绿实证**：删掉 `settings/mediaserver/page.tsx` 的判定，门禁报
`settings/mediaserver/page.tsx`；恢复后转绿。

### 6.3 `route-auth-inventory.test.ts`（既有表驱动，守**API**）

`ROUTE_PERMISSION_TABLE` 登记三条 `/chat` 端点，`WIRED_ROUTE_COUNT` 37 → 40。
门禁本身不变：声明的权限点必须与源码里 `requirePermission(字面量)` 一致，且权限点必须在
`PERMISSION_CATALOG` 里。因此「助理 API 只要求登录」这个状态无法再回来。

### 6.4 行为断言（守**表现**）

`resource-search-empty.test.ts` 新增 3 个用例：
- 无设置权限 → 源码错误卡片不渲染 `href="/settings"`，改为「联系站长」；
- 成员在普通无结果卡片里拿不到 `/settings` 与 `/storage`；
- 站长（显式 `true`）仍保留完整入口（不回归）。

`settings-tabs-model.test.ts` 新增 1 个用例：`#password` 不再映射到 account tab。

---

### 6.5 覆盖面补齐：104 条路由 + 15 个页面全部显式归类

上一轮只接了 37/124 条路由与 1 个页面子树，剩下 65 条仍是「登录即可」。
按「无正式发布、不留兼容垫片」的前提一次性做完：

| 层 | 覆盖面 | 门禁断言 |
| --- | --- | --- |
| API | **104/104** 条非白名单路由都声明了权限点（`ROUTE_PERMISSION_TABLE`） | 「非白名单路由全部在清单里」——新增端点不归类直接红 |
| 页面 | **15/15** 个 page.tsx 都显式归类（`PAGE_PERMISSION_TABLE`，含 `permission: null` 的登录即可页） | 「每个受管页面都在清单里」+「按声明的权限点真的判定了」 |

两张表都是**声明式**的：值可以是权限点、权限点数组（同一文件读/写用不同钥匙，
例如 `GET /api/library` 读库列表 → `media:detail`，`POST` 新建库 → `library:manage`），
或 `null`（登录即可）。数组里每个元素都必须在源码里真的被调用过。

关键归属决策（用户 2026-11-16 确认）：

- **网盘扫码登录**（115 / quark / pan123 / tianyi / uc / guangya 共 23 条）
  → `system:settings`。绑定网盘账号会换掉全站的数据源，属实例配置写动作；
- 助理 MCP 服务器、扩展、媒体服务器、STRM 任务、FRP 隧道、本地文件浏览器
  → `system:settings`（它们都能触达外网 / 读宿主机 / 注入代码）；
- `titles/*` 按动作分：搜索 → `media:search`、入库 → `storage:transfer`、
  整理 → `storage:organize`、订阅策略 → `media:subscribe`；
- `media-requests` 仍是 `workflow:status`：它自身已按「本人 vs 站长」过滤行级数据，
  权限点只决定「能不能看这块面板」。

同时把页面守卫从「逐页复制」改成表驱动，并钉死两条反向不变量：

- `permission: null` 的页面（`/account`）**不得**出现 `decidePageAccess`——
  一旦有人给它补一个权限判定，成员就会再次被挡在自己的改密页外（上一轮的缺陷原型）；
- `permission: <某点>` 的页面必须同时出现 `decidePageAccess` 与该权限点字面量。

顺带修掉两处「用模式猜权限」的旧写法：

- `/show/[tmdbId]` 的 `canManageMedia` 过去是 `!isSharedResourceMode() || isOwner`，
  完全没看成员的真实权限集 → `OrganizePanel` 现在自己按 `useAuth().can("storage:organize")`
  渲染；
- 该页 600 行硬上限被权限守卫顶破，把 `?from/?w/?q/?t` 四个易错分支抽成
  [show-page-params.ts](../../apps/web/features/catalog/core/show-page-params.ts) 并补 4 个纯函数用例。

---

## 7. 为什么不选另外两条路

| 方案 | 否决理由 |
| --- | --- |
| 给 `/settings` 开一个「成员可进 account tab」的例外 | 一个页面回到「分区分权限」模式，正是上一轮迁移要消灭的东西；且 `/settings` 的 Server Component 已经在页面顶部整体 403，要开例外得改守卫语义 |
| 让 `/account` 也能承载「账号管理」分区 | 两个权限域重新混在一页；站长要维护两套入口。业界三家都是物理分离 |
| 引入 Casbin/Oso 做集中策略 | 策略表达力不是瓶颈，执行覆盖才是。多一层 DSL + 加载器，换不来这次需要的「链接不得手写」 |

---

## 8. 变更清单

| 文件 | 变更 |
| --- | --- |
| `apps/web/features/auth/core/account-links.ts` | **新增**：两个 URL 的唯一构造器 |
| `apps/web/features/auth/components/account-identity.tsx` | 改密/账号管理链接改用构造器（**本次根因**） |
| `apps/web/features/auth/components/user-profile-modal.tsx` | 同上 |
| `apps/web/features/settings-system/components/settings/remote-access-section.tsx` | 同上 |
| `apps/web/features/settings-system/core/remote-access.ts` | `accountPasswordHref` 委托构造器 |
| `apps/web/features/settings-system/core/settings-tabs-model.ts` | `#password` 移出 legacy 锚点集合 |
| `apps/web/app/settings/mediaserver/page.tsx` | 补 `system:settings` 判定 |
| `apps/web/app/settings/extensions/page.tsx` | 补 `system:settings` 判定 |
| `apps/web/app/chat/page.tsx` | 补 `assistant:chat` 判定 |
| `apps/web/app/api/chat{,/conversations,/conversations/[id]}/route.ts` | `requireApiAccount` → `requirePermission("assistant:chat")` |
| `apps/web/platform/next-context/route-permission-table.ts` | **重写**：104 条路由全部归类（值支持权限点数组），计数 37 → 104 |
| `apps/web/platform/next-context/page-permission-table.ts` | **新增**：15 个页面 → 权限点（含 `null` = 登录即可） |
| `apps/web/app/api/**`（65 个 route.ts） | `requireApiAccount` → `requirePermission(域权限点)`；读/写异钥匙的用文件级 `const accountId = gate.accountId` |
| `apps/web/app/{page,activity,notifications,library,foreign-work/[workflowRunId],show/[tmdbId],w/[storageId]}/page.tsx` | 补 `decidePageAccess`（`media:search` / `workflow:status` / `notifications:read` / `media:detail`） |
| `apps/web/features/catalog/core/show-page-params.ts` | **新增**：`/show` 的 4 个 query 分支抽成纯函数（600 行硬上限） |
| `apps/web/features/acquisition/components/title-organize-panel.tsx` | 按 `useAuth().can("storage:organize")` 渲染 |
| `apps/web/app/api/route-auth-inventory.test.ts` | 新增「非白名单路由全部在清单里」；数组权限点逐项核对；计数 104 |
| `apps/web/app/api/page-auth-inventory.test.ts` | 改为表驱动全量覆盖（归类 / 计数 / 目录校验 / 反向不变量） |
| `apps/web/features/acquisition/components/resource-empty-diagnostic.tsx` | `canOpenSettings` / `canBrowseStorage` 按可达性渲染 CTA |
| `apps/web/features/acquisition/components/resource-candidates-list.tsx` | 透传两个开关 |
| `apps/web/features/acquisition/components/title-resource-panel.tsx` | `useAuth().can()` 注入开关 |
| `apps/web/tests/unit/auth/gated-link-reachability.test.ts` | **新增**：入口可达性门禁（7 用例） |
| `apps/web/app/api/page-auth-inventory.test.ts` | 新增 `app/settings/**` 子树断言 |
| `apps/web/app/api/route-auth-inventory.test.ts` | 计数 37 → 40 |
| `apps/web/features/acquisition/components/resource-search-empty.test.ts` | 新增 3 个可达性用例 |
| `apps/web/lib/settings-tabs-model.test.ts` | `#password` 不再映射 |

---

## 9. 验收

Dev 实例（`192.168.1.100:3020`，`MEDIA_TRACK_MULTI_USER=1` + `MULTI_USER_MODE=shared`），
部署 `0004d36c-dirty-070118`（含本次全部改动）。

| # | 步骤 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | 成员展开侧边栏头像 | 「修改密码」href = `/account#password` | `修改密码 -> /account#password` ✅ |
| 2 | 成员在 `/account#password` 输入当前密码 + 新密码提交 | 成功，跳 `/login`，旧密码失效 | 页面跳转 `/login`；旧密码 401、新密码 200 ✅ |
| 3 | 成员手输 `/settings` | 403 面板 | 200 + 「权限不足 / 所需权限：system:settings」✅ |
| 4 | 成员手输 `/settings/mediaserver` | 403 面板（**此前可进**） | 「所需权限：system:settings」✅ |
| 5 | 成员手输 `/settings/extensions` | 403 面板（**此前可进**） | 「所需权限：system:settings」✅ |
| 6 | 成员手输 `/chat`；`POST /api/chat` | 页面 403；API 403 | 页面「所需权限：assistant:chat」；API `403 {"error":"权限不足：缺少 [assistant:chat] 访问权限。"}` ✅ |
| 7 | 成员访问 `/`、`/?tab=library`、`/library`、`/notifications`、`/activity`、`/account` | 全部 200，无 403 | 6/6 http=200，页面无「权限不足」✅ |
| 8 | 站长访问 `/settings`、`/settings/mediaserver`、`/settings/extensions`、`/chat`、`/account` | 全部 200（不回归） | 5/5 http=200 ✅ |

### 9.2 全量接线后的复验（部署 `0004d36c-dirty-100106`）

成员（`role_member`，权限集 = media:search/detail/play/subscribe、notifications:read、
storage:list/transfer、workflow:status）：

| 探针 | 结果 |
| --- | --- |
| 页面 `/`、`/library`、`/notifications`、`/activity`、`/account` | 200，无「权限不足」 |
| 页面 `/settings`、`/settings/mediaserver`、`/settings/extensions`、`/chat`、`/storage`、`/storage/strm` | 200 + 「权限不足」面板（403 语义，SSR 内联） |
| `POST /api/115/qrcode` | 403 `缺少 [system:settings]`（站长 200 拿到扫码 session） |
| `POST /api/titles/organize` | 403 `缺少 [storage:organize]` |
| `POST /api/library` | 403 `缺少 [library:manage]` |
| `GET /api/strm/tasks`、`/api/mediaserver/configs`、`/api/extensions`、`/api/assistant/mcp-servers`、`/api/tunnel/lines`、`/api/system/fs-browse` | 全部 403 |
| `GET /api/library`、`/api/storage/drives`、`/api/media-requests`、`/api/notifications/meta`、`/api/activity` | 全部 200 |
| `POST /api/titles/import`、`POST /api/storage/offline`、`POST /api/titles/resources` | 通过权限门（分别落到各自的参数/业务校验：400/200/400） |
| `GET /api/storage/files`（不带 storageId） | 403 `OUTSIDE_LIBRARY_SCOPE` —— 目录范围校验按预期先于内容返回生效 |

站长（`role_owner`）：11 个页面全部 200 且无「权限不足」；7 个配置面 API 全部 200。

注：验收用临时生成的成员密码，按 AGENTS.md §7 不写入任何文档。

---

## 10. 参考来源

检索与核对日期：2026-11-16。

- [S1 Jellyfin — Managing Users](https://jellyfin.org/docs/general/server/users/adding-managing-users/)：个人菜单与管理 Dashboard 的分离；每用户可配置项。
- [S2 Plex — Account & Server Settings](https://support.plex.tv/articles/115007570148-automatically-adjust-quality-when-streaming/)：账户设置与服务器设置的权限归属（server owner）。
- [S3 Emby 社区 — 修改用户画质设置](https://emby.media/community/topic/136784-allow-emby-server-owners-to-change-users-quality-settings/)：画质是 per-app 设置而非 per-user，说明「个人面 / 管理面」需显式设计。
- [S4 OWASP — Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：deny by default、逐请求校验、最小权限、集中执行点。
- [S5 OWASP Top 10:2021 — A01 Broken Access Control](https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/)：违反最小权限/默认拒绝即属该类缺陷。
- [S6 Next.js — Authentication 指南](https://nextjs.org/docs/app/guides/authentication)：Server Component 做权威判定，Middleware 只做乐观检查。
- [S7 NVD — CVE-2025-29927](https://nvd.nist.gov/vuln/detail/CVE-2025-29927)：Next.js middleware 可被 `x-middleware-subrequest` 绕过，授权不能在 middleware 里。
- [S8 Apache Casbin](https://casbin.apache.org/) 与 [Authzed — Casbin vs SpiceDB](https://authzed.com/blog/casbin)：策略引擎擅长策略表达（多租户/ReBAC），本项目策略形状固定，属过度设计。

本地设施核对（基线 `0004d36c`）：[account-links.ts](../../apps/web/features/auth/core/account-links.ts)、
[account-identity.tsx](../../apps/web/features/auth/components/account-identity.tsx)、
[page-permission-guard.ts](../../apps/web/platform/next-context/page-permission-guard.ts)、
[route-permission-table.ts](../../apps/web/platform/next-context/route-permission-table.ts)、
[nav-visibility.ts](../../apps/web/features/auth/core/nav-visibility.ts)、
[route-auth-inventory.test.ts](../../apps/web/app/api/route-auth-inventory.test.ts)、
[page-auth-inventory.test.ts](../../apps/web/app/api/page-auth-inventory.test.ts)。
