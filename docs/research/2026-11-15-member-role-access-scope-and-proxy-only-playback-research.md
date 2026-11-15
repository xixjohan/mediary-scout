# 标准成员角色收敛访问面与强制代理播放：可行性调研与方案

日期：2026-11-15（Asia/Hong_Kong）。本地基线：`24328515`（mediary 分支）。

> 本文是新增研究稿，**不授权实施**，不做生产变更，不覆盖用户正在修改的业务文件与其他研究文档。

## 1. 需求与两处口径澄清

用户以三条编号需求描述「标准成员」应收敛到什么：

1. 只允许 **搜索 / 订阅 / 查看影视库 / 播放视频 / 查看通知 / 活动**；其它（**设置页面 / 影视库 / strm**）都不允许访问
2. 不允许查看和访问 **非媒体库根目录外** 的网盘文件
3. 视频播放 **只允许代理模式**，不能使用 302 直链

### 1.1 需求 1 的内部张力（已定案）

允许列表写了「查看影视库」，括号里又把「影视库」列入禁止。结合需求 2「不允许访问**非媒体库根目录外**的网盘文件」可推断：媒体库目录树本身是允许浏览的。

**用户 2026-11-15 确认：括号里的「影视库」指影视库管理面**（新建库 / 立即扫描库 / 库设置与路径 / 批量删除），不是「查看影视库内容」。本文按此定案实施。

### 1.2 四条决策（用户 2026-11-15 确认，为实施依据）

| # | 决策 | 对方案的影响 |
| --- | --- | --- |
| 1 | 「影视库」禁止的是**管理面** | 查看内容允许；只封 POST/PUT/DELETE 与管理入口 |
| 2 | 成员**保留「发起获取」** | `role_member` **保留** `storage:transfer`；不额外授予 `workflow:trigger` |
| 3 | **强制代理功能不做**，保持按库规则播放 | §3.4 与 P2 阶段整体删除；302/代理仍按现有责任链与库配置 |
| 4 | 服务器带宽预算暂不考虑 | 无带宽规划工作 |

**决策 3 的直接后果**：需求 3 原始表述「只允许代理模式不能 302」**本轮不做**。现状维持——投送模式仍由「账号偏好 > 路径绑定 > 影视库配置 > 全局 > 驱动约束」决定，302 仍可选。若未来要收紧，§3.4 的方案可作为预备设计保留（不改代码）。

## 2. 现状勘查：三层缺口，第一层是「配置了但完全不生效」

### 2.1 关键发现：权限目录已存在，但 Web 侧从未消费

系统**已经有**一套 RBAC 目录：

- [`PERMISSION_CATALOG`](../../packages/shared/src/auth/api-key-matrix.ts) 定义 12 个权限点
- [`BUILTIN_ROLES`](../../packages/shared/src/auth/rbac-matrix.ts#L70) 的 `role_member` **已被赋 7 项**：media:search、media:detail、media:subscribe、storage:list、storage:transfer、workflow:status、assistant:chat
- 角色管理面板 [role-management-panel.tsx](../../apps/web/features/settings-system/components/role-management-panel.tsx) 允许站长按模块勾选权限并 PUT 到 [/api/settings/roles/[id]](../../apps/web/app/api/settings/roles/[id]/route.ts)

但**这 7 项权限在 Web 侧没有任何执行点**：

| 事实 | 证据 |
| --- | --- |
| 105 个受保护 API 路由**全部**只调 `requireApiAccount` | `grep -rl requireApiAccount apps/web/app/api --include=route.ts` → 105 |
| 细粒度守卫 `requirePermission()` 在业务路由中被调用 **0 次** | `grep -rl requirePermission apps/web/app/api` → 0；函数定义在 [auth-chain.ts:225](../../apps/web/platform/next-context/auth-chain.ts#L225) |
| 唯一消费权限点的是 MCP 路由 | [api/mcp/route.ts:269](../../apps/web/app/api/mcp/route.ts#L269) |

**结论**：标准成员登录后的页面与 API 访问面**与站长基本相同**。站长在角色面板取消勾选权限，对 Web 页面与 REST API **完全无效**——那只影响 API Key 的委派边界（`calculateEffectivePermissions`）。

### 2.2 页面层：只有「登录了没」的判定，没有「能不能看」的判定

- 页面守卫 [page-auth-guard.ts:13](../../apps/web/platform/next-context/page-auth-guard.ts#L13) 的判据是 `guarded && passwordState && !hasSession` —— 纯登录态。
- 侧边栏 [app-sidebar.tsx:99](../../apps/web/components/layout/app-sidebar.tsx#L99) 无条件渲染全部导航项（网盘 / 影视库 / 通知 / 活动 / 设置），没有任何角色过滤。
- `apps/web/app/*/page.tsx` 中**零处** `roleId` / `isMaster` / `permissions` 判定。

### 2.3 目录范围：媒体库 CID 已解析，但列表接口不设边界

- 连通存储已持久化 `rootCid` / `moviesCid` / `tvCid` / `animeCid`（[account-credentials.ts:45](../../packages/workflow/src/storage/account-credentials.ts#L45)）。
- [storage/files/route.ts:155](../../apps/web/app/api/storage/files/route.ts#L155) 接受任意 `dirId` / `parentId`，直接交给 [drive-file-manager.ts:78](../../packages/workflow/src/storage/drive-file-manager.ts#L78) 的 `listDirectory`。**没有任何"必须在媒体库根内"的校验**。
- 同类缺口覆盖存储域全部写操作：`files/adopt`、`files/copy`、`files/delete`、`files/folder`、`files/move`、`offline`、`scan` —— 每一个都取客户端给的 id，均由 `requireApiAccount` 放行。

### 2.4 播放投送：302 是可选路径，且客户端可自行改写

- 判断函数 [strm-delivery.ts:91](../../packages/workflow/src/strm/strm-delivery.ts#L91) 已有完整责任链：显式 proxy 优先 → 夸克/UC 强制 proxy → 115 在 auto 下走 proxy → 其余按 UA。
- 但播放路由 [strm/play/route.ts:411-429](../../apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts#L411) **优先尊重客户端传入的 `?delivery=` 参数**，客户端可以显式要 `redirect`。
- 前端播放器 [mediary-player-modal.tsx:144](../../apps/web/features/player/components/mediary-player-modal.tsx#L144) 有「切为302直连」按钮，并把偏好写进账号设置（[player-delivery-actions.ts:37](../../apps/web/app/actions/player-delivery-actions.ts#L37)）。
- 更要紧的是：`strm/play` **不调 `requireApiAccount`**（[route-inventory 测试](../../apps/web/app/api/route-auth-inventory.test.ts) 把它单列为 `STRM_PLAY_ROUTES` 自鉴权类），其鉴权只是可选的播放签名 `validatePlayToken`，且 `STRM_AUTH_STRICT` 默认关闭——无 token 也放行。

即：**302 直链在当前架构里既是可选配置，也是客户端可绕过服务端策略自行选择的路径，还是几乎无鉴权的端点。**

### 2.5 已有但**未接线**的多用户基础设施（可直接复用，零新增依赖）

| 设施 | 位置 | 状态 |
| --- | --- | --- |
| 多用户模式三态 `off / isolated / shared` | [storage-scope-strategy.ts:3](../../packages/workflow/src/domain/storage-scope-strategy.ts#L3) `getMultiUserMode()` | 已实现，**被 workflow-runtime 重导出但无业务消费** |
| 存储域策略族（三个 Strategy + `createStorageScopeStrategy()`） | 同文件 L45–L101 | **策略模式已就绪，零调用方** |
| 能力适配器 `UserCapabilityAdapter.getCapabilities()` 返回 canManageDrives / canDeleteMedia / canViewGlobalSettings / dailyRequestQuota | [user-capability-adapter.ts](../../packages/workflow/src/domain/user-capability-adapter.ts) | **已实现，仅被单元测试引用** |
| 角色存储 `updateRole`（可改内置角色 permissions；站长的 `*` 强制保留） | [role-store.ts:113](../../packages/workflow/src/auth/role-store.ts#L113) | 已可用：`role_member` **本身可配置**，无需新建角色 |
| 站长判定 `resolveCurrentIsOwner()` | [settings-attention-server.ts:57](../../apps/web/features/settings-system/application/settings-attention-server.ts#L57) | 已被 settings 域 4 个路由使用 |

**这是本次方案最省力的地方**：不需要引入 Casbin／OPA 之类的策略引擎，也不需要新建角色；要做的是把「已存在的权限点 + 已存在的策略族」真正接到页面与 API 上。

## 3. 方案设计

### 3.1 三条需求落到三个机制（其中第三条本轮不做）

| 需求 | 机制 | 为什么不能用一个机制做完 | 本轮 |
| --- | --- | --- | --- |
| 1 页面/功能访问面 | **RBAC**：页面级 permissions 判定 + 侧边栏过滤 + API 断言 | 这是「功能开关」，与数据范围无关 | ✅ 做（含管理面单独关闭） |
| 2 网盘目录边界 | **ABAC / 数据范围**：内容所属校验（breadcrumb 包含关系） | RBAC 只知道「能不能看网盘」，不知道「能看哪一个目录」 | ✅ 做 |
| 3 强制代理播放 | **策略 + 服务端裁决**：把投送模式从「客户端可选」改为「服务端强制」 | 这是驱动约束与安全策略，不是权限点 | ❌ 不做（决策 3） |

**功能权限走 RBAC，数据范围走 ABAC**。混用会产生典型 bug——把目录边界塞进权限点（每加一个目录就要加一条权限），或把代理要求塞进 RBAC（同一个人在同一库里忽而被强制、忽而可绕过）。

### 3.2 需求 1：页面与 API 的权限收敛

#### 3.2.1 定义页面级权限点（复用现有 catalog，**不新增命名空间**）

现有权限点已覆盖大部分：`media:search`（搜索）、`media:subscribe`（订阅）、`storage:list`（浏览媒体库/网盘）、`workflow:status`（活动 + 通知）、`assistant:chat`。

缺的是：通知的独立读权限、播放的独立权限、设置页的独立权限，以及「影视库管理面」与「查看影视库内容」的区分。

建议**新增 4 个权限点**（而非复用语义不匹配的旧点）：

| 新权限点 | 语义 | 风险级 |
| --- | --- | --- |
| `media:play` | 播放库内视频（含字幕） | Read |
| `notifications:read` | 查看通知列表 | Read |
| `system:settings` | 查看与修改系统设置页（配置面） | Execute |
| `library:manage` | 影视库管理面：新建/扫描/路径绑定/批量改删元数据 | Execute |

`library:manage` 是决策 1 的落点：**「查看影视库」不需要它，「管理影视库」需要它**。成员不持有，站长/管理员持有。

并把 `storage:list` 语义收紧为「浏览媒体库目录树」，新增 `storage:browse_any` 表示「浏览网盘任意目录」（仅站长/管理员默认持有）。这样需求 2 就有了**权限层前置闸**，与内容层校验形成双保险。

`role_member` 新权限集（对齐需求 1 + 决策 2）：

```
media:search, media:detail, media:subscribe, media:play,
storage:list, storage:transfer, notifications:read, workflow:status
```

**去掉** `assistant:chat`（需求 1 的允许列表未含「助理」）与 `storage:organize`／`storage:delete`（本就不在成员集内）。`system:settings`、`storage:browse_any` 不授予。

**保留** `storage:transfer`——决策 2 明确「成员保留发起获取」。注意这不等于放开任意写盘：转存目标目录仍受 §3.3 的媒体库范围约束。

#### 3.2.2 页面层：服务端判定 + 侧边栏过滤（双写，非二选一）

- 页面守卫从「登录态」扩展为「登录态 + 页面权限」。复用 [page-auth-guard.ts:13](../../apps/web/platform/next-context/page-auth-guard.ts#L13) 的纯函数模式：新增 `shouldDenyPage(...)` 返回 allow/deny，**保持纯函数**便于表驱动测试。
- `/settings`、`/storage`、`/storage/strm` 三个页面在服务端判定，无权时**返回 403 页面而非 redirect**（redirect 会让用户不知道被拒了）。`/library` 允许进入（决策 1：只禁管理面）。
- 侧边栏按权限过滤导航项。**这只是 UX 优化，绝不是安全边界**——见 §4 的 CVE 说明。

**决策 1 的关键细节：`/library` 允许进入，但管理入口必须关掉。** 影视库页面上有四个管理动作，它们的入口分散在组件里：

| 管理动作 | 入口 | 封禁点 |
| --- | --- | --- |
| 新建库 | `新建库` → `POST /api/library` | API 断言 |
| 立即扫描库 | `立即扫描库` → `POST /api/storage/scan` | API 断言 |
| 库设置与路径 | `库设置与路径` → `/api/library/[id]/paths` 系列 | API 断言 |
| 批量管理 | 批量删除/重命名 → `/api/library/items/*` | API 断言 |
| 单片元数据编辑 | `edit-metadata-modal` → `/api/library/items/[itemId]/*` | API 断言 |

**只隐藏按钮是无效的**——这些组件都直接 `fetch()`，绕过 UI 照样能打到接口。所以关闭点必须在 API（下表 B1/B3），UI 隐藏只作为体验补充。

#### 3.2.3 API 层：把 `requirePermission()` 真正接上

这是工作量最大也最有价值的一块：105 个路由从「仅登录」升级为「登录 + 权限」。**不建议一次全改**，按域分批：

| 批次 | 路由域 | 权限点 |
| --- | --- | --- |
| B1 | library/*（含播放、items 管理） | 读→media:detail / media:play；写→`library:manage` |
| B2 | storage/files/*、storage/offline、storage/scan | 读→storage:list + 范围校验；写→storage:transfer + 范围校验；scan→`library:manage` |
| B3 | settings/*、strm/tasks/* | system:settings |
| B4 | activity、notifications | workflow:status / notifications:read |

**站长与单用户模式必须零摩擦**：`requirePermission` 已内建 `sec.isMaster || permissions.has("*")` 短路（[auth-chain.ts:238](../../apps/web/platform/next-context/auth-chain.ts#L238)），单用户局域网回退上下文直接给 `["*"]`。因此单用户部署**行为完全不变**——必须在测试里锁定。

注意 B2 有一个**同一接口服务两种用途**的陷阱：`/api/storage/files` 既被成员用作「浏览媒体库目录」（允许），也被网盘管理器 `storage-manager-view` 用作「任意目录运维」（禁止）。因此 B2 **不能靠权限点一刀切**，必须叠加 §3.3 的范围校验：成员带 `storage:list` 就能调，但只能落到媒体库根内的目录。

**站长与单用户模式必须零摩擦**：`requirePermission` 已内建 `sec.isMaster || permissions.has("*")` 短路（[auth-chain.ts:238](../../apps/web/platform/next-context/auth-chain.ts#L238)），单用户局域网回退上下文直接给 `["*"]`。因此单用户部署**行为完全不变**——必须在测试里锁定。

#### 3.2.4 门禁：路由鉴权清单升级为「权限清单」

现有 [route-auth-inventory.test.ts](../../apps/web/app/api/route-auth-inventory.test.ts) 只断言「引用了 requireApiAccount」。升级为**声明式权限表**：每个路由**必须**出现在 `ROUTE_PERMISSIONS` 里，且源码中 `usesImportedFunction(source, "requirePermission")` 为真。**新增路由未归类即门禁失败**——「配了权限但不生效」这个当前缺陷不可能再回来。

### 3.3 需求 2：网盘目录边界的 ABAC 校验

#### 3.3.1 数据依据现成，不需要额外 API 调用

115 的目录列表响应**自带** `path`（面包屑），代码已解析为 breadcrumbs：[drive-file-manager.ts:188](../../packages/workflow/src/storage/drive-file-manager.ts#L188)、[pan115-cookie-client.ts:180](../../packages/workflow/src/storage/pan115-cookie-client.ts#L180)。因此「这个目录是否在媒体库根之内」**可在同一次列表响应里判定，零额外调用**：

```ts
function isWithinLibraryRoots(breadcrumbs, libraryRootCids) {
  if (libraryRootCids.length === 0) return false;   // 未配置 = 拒绝（fail-closed）
  const ids = new Set(breadcrumbs.map((b) => b.id));
  return libraryRootCids.some((root) => ids.has(root));
}
```

**fail-closed 是关键**：媒体库 CID 尚未解析的新连接 → **拒绝**，而不是放行。放行会让「还没配好」的窗口变成越权窗口。

#### 3.3.2 校验点：只在这一处做，不在每个路由里复制

新增 `assertWithinLibraryRoots(...)` 放在**存储域服务公共入口**：

- `listDirectory(dirId)`：先取 breadcrumbs（随列表返回，不额外调用），再断言
- `delete/copy/move/rename/adopt`：目标 dir 与源 dir 双向断言
- `offline`（转存）：目标目录断言——**这是决策 2 的关键配套**：成员保留了「发起获取」，但转存目标必须落在媒体库范围内，否则「保留发起获取」会变成「可以往任意目录写文件」

**性能**：零额外 API 调用。这是本方案最重要的性能结论——若额外调 `getDirectoryInfo`，每次浏览都会多一次 115 调用，在 1200ms 漏桶下显著拖慢。

**一个必须承认的精度损失**：媒体库根（`rootCid`）与三个分类目录（`moviesCid` / `tvCid` / `animeCid`）之间是父子关系。若把 `rootCid` 也算作合法根，成员就能看到根下属性的任意目录（包括非媒体库的东西）。因此**合法根应取三个分类目录，而不是 `rootCid`**；只有当用户明确把分类目录建在盘根时两者才等价。这条要在实现时按存储的实际 CID 结构决定，并在测试里用「根下有个无关目录」的夹具锁定。

#### 3.3.3 边界与缺口

- **深层目录 breadcrumbs 依赖驱动**：115 返回；其他品牌不一定。不返回的驱动只能 fail-closed，或降级为「仅允许根目录一级」——需按驱动能力表明确。
- breadcrumbs 只给「路径」，不给「文件归属」。单个文件的直链解析（strm/play）没有目录上下文。**因决策 3 移除了强制代理**，这条缺口本轮不处理：播放侧不依赖目录树，只依赖 `fileId`。

### 3.4 需求 3：强制代理播放 —— **本轮不做**（决策 3）

用户明确「强制代理功能不做，保持按库规则播放」。因此：

- **不改** `determineEffectiveDeliveryMode` 责任链，不加 `enforceProxyOnly` 层；
- **不改** 播放路由的 `?delivery=` 优先级，客户端仍可显式选择；
- **不改** 播放器「切为302直连」按钮的存在性；
- 不做带宽预算规划（决策 4）。

下列 3.4.1–3.4.4 作为**预备设计**保留，仅在将来要收紧时参考，**不进入本轮实施范围**。

#### 3.4.1（预备）现状的三条绕过路径

| 绕过路径 | 现状 | 若将来收紧的修法 |
| --- | --- | --- |
| 客户端传 `?delivery=redirect` | [route.ts:428](../../apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts#L428) 优先尊重客户端 | 服务端强制闸：要求 proxy 时忽略 query 参数 |
| 播放器 UI「切为302直连」+ 持久化偏好 | [mediary-player-modal.tsx:144](../../apps/web/features/player/components/mediary-player-modal.tsx#L144) | 成员角色下不渲染该按钮；服务端同时拒绝该偏好 |
| strm/play 无会话鉴权 | 仅可选签名，STRM_AUTH_STRICT 默认关 | 该路由接入 requireApiAccount 或要求签名 |

#### 3.4.2 责任链扩一层：policyOverride

现有 [strm-delivery.ts:91](../../packages/workflow/src/strm/strm-delivery.ts#L91) 已是责任链，只需在**最前面**加一层：

```
服务端强制策略(role/library) > session > binding > library > global > 驱动约束
```

语义是**单调收紧**（可把 redirect 收紧为 proxy，不能反向放宽）：

```ts
function enforceProxyOnly(requested, policy) {
  return policy.forcedProxy ? "proxy" : requested;
}
```

**为什么放在最前而非塞进驱动约束**：驱动约束表达「这个盘物理上不能 302」（客观事实），强制代理表达「这个账号/这个库不允许 302」（策略）。两者要能分别测试、分别解释——合并会让「为什么我被强制代理」无法回答。

#### 3.4.3 缓存键必须带策略维度

[strm-delivery.ts:130](../../packages/workflow/src/strm/strm-delivery.ts#L130) 的缓存键含 deliveryMode（现状已如此），但要在测试里锁死：强制 proxy 绝不能复用别人 redirect 的缓存条目。

#### 3.4.4 性能代价（必须明确告知）

强制代理 = **所有成员播放流量经过服务器**：

- 服务器出口带宽 = 成员并发 × 码率。4K（约 50 Mbps）× 3 人 ≈ 150 Mbps 常驻。
- 代理模式统一共享缓存键（不像 redirect 按 UA 分键），**对 115 配额反而更友好**——这是需求 3 的意外收益。

### 3.5 设计模式落点

| 模式 | 用在哪 | 复用还是新建 |
| --- | --- | --- |
| **策略模式** | 存储域 IStorageScopeStrategy（已有） | **复用**，把 createStorageScopeStrategy 接到 service 层 |
| **适配器模式** | UserCapabilityAdapter（已有）扩展为「角色 → 页面/权限集合」映射 | **复用** |
| **状态机** | **不建议引入** | 两条范围需求都是无状态判定，没有需要迁移的状态 |
| **装饰器模式** | requirePermission 包在 requireApiAccount 外层 | **复用**既有两层结构 |

**明确不建议** Casbin / OPA / SpiceDB：权限点只有十几条、角色 5 个，策略引擎的维护成本远大于收益，且引入外部 DSL 会削弱可审计性。

**强制代理（原需求 3）已按决策 3 移出范围**，因此 `enforceProxyOnly` 不实施；责任链保持现状。

## 4. 业界对照

| 方案 | 做法 | 可借鉴点 |
| --- | --- | --- |
| **Jellyfin** | 每用户可勾选「允许访问所有库」或逐库授权；未授权的新库**不会**自动授予 | 与需求 1/2 最接近的成熟范式：库级授权 + 默认收紧。可照搬「新建库不自动授予」 |
| **Plex** | 库级共享 + 每用户限制 | 库级粒度足够，不需要文件级 ACL |
| **Next.js 官方认证指南** | Server Component 做角色判定，**Middleware 只做乐观检查**，DB 校验在服务端 | 与本方案「侧边栏过滤是 UX、页面/API 才是边界」一致 |
| **CVE-2025-29927** | middleware 可被 `x-middleware-subrequest` 头绕过 | **决定性证据**：授权放 middleware/proxy 必须配服务端二次校验。本方案因此把判定放在页面与 API 服务端，不依赖 [proxy.ts:63](../../apps/web/proxy.ts#L63) |
| **Casbin / SpiceDB** | 外部策略引擎，支持 ACL/RBAC/ABAC/ReBAC | 规模大才值得；本项目十几条权限用代码表更简单 |
| **RBAC vs ABAC** | RBAC 管「角色能否做某类动作」，ABAC 管「这个具体对象能不能碰」 | 需求 1 用 RBAC、需求 2 用 ABAC |

## 5. 可行性与风险

### 5.1 分项结论（按四条决策更新）

| 项 | 本轮是否做 | 可行性 | 工作量 | 风险 |
| --- | --- | --- | --- | --- |
| 需求 1 页面与 API 权限收敛 | **做** | **高**（权限点与守卫都已存在） | 中（105 路由分批 + 门禁） | 漏接一路 = 越权；靠声明式门禁兜住 |
| 影视库「管理面」单独关闭 | **做** | 高（新增 library:manage 权限点） | 小 | 页面按钮隐藏不等于关闭，必须在 API 落点 |
| 需求 2 目录边界 | **做** | **高**（breadcrumbs 已有，零额外调用） | 中 | 非 115 驱动可能不返面包屑 → fail-closed 挡合法访问 |
| 需求 3 强制代理 | **不做**（决策 3） | — | 0 | 维持现状：302 仍可按库规则使用 |
| 成员保留发起获取 | **做**（决策 2：保留） | 高（权限点现成） | 0 | 转存目标目录仍受需求 2 约束 |
| 服务器带宽规划 | **不做**（决策 4） | — | 0 | 无 |

### 5.2 逻辑风险

| 风险 | 缓解 |
| --- | --- |
| **单用户部署被误伤**（站长被自己锁在外面） | isMaster/`*` 短路 + 单用户回退给 `["*"]`；测试锁定 off 模式全放行 |
| **内置角色被改坏** | 站长有最终裁量权（现有设计）；建议提供「恢复内置默认」按钮 |
| **目录边界 fail-closed 误伤** | 错误文案区分「未配置」与「越权」，让用户知道去设置绑定目录 |
| **`/api/storage/files` 一接口两用途** | 成员浏览媒体库（允许）与运维任意目录（禁止）共用该端点 → 必须先按 §3.3 加范围校验，不能只靠权限点 |
| **页面隐藏 ≠ 关闭** | 库管理组件直接 fetch API，藏按钮无效 → 关闭点必须在 API |
| **单用户模式仍走 role_member** | 单用户未设密码时局域网回退给 `*`；设了密码后单用户账号 `isOwner=true` → 走 role_owner。两种路径都不受成员限制影响 |
| **proxy 层被 CVE 绕过** | 全部判定落在页面/API 服务端 |

### 5.3 性能

- 需求 1：内存集合查表 + 角色 15s 内存缓存，**零显著 I/O**
- 需求 2：breadcrumbs 随列表返回，**零额外 API 调用**
- 强制代理不做，无带宽影响

## 6. 测试矩阵

| 场景 | 必须验证 |
| --- | --- |
| 单用户模式 | 全部页面/API 零摩擦，行为与改动前完全一致 |
| 站长 | 全部权限可用，`*` 短路生效 |
| 成员访问 设置/网盘/strm 页面 | 403 页面（非 redirect），侧边栏不渲染入口 |
| 成员访问 library 查看 / search / activity / notifications | 正常 |
| 成员调用库管理接口（新建库 / 扫描 / 路径绑定 / 批量改删 / 元数据编辑） | 403，且**不产生任何 115 调用** |
| 成员发起获取（决策 2：允许） | 正常入队 |
| 成员转存到媒体库范围内的目录 | 允许 |
| 成员转存到媒体库范围外的目录 | 403（需求 2 兜住决策 2 的放开） |
| 成员浏览媒体库根内目录 | 允许 |
| 成员浏览媒体库根外目录 | 拒绝；空根配置→拒绝（fail-closed） |
| 品牌不返回 breadcrumbs | 拒绝并给出可区分文案 |
| 新增 API 路由未登记权限点 | 门禁失败 |
| 站长把 role_member 改回全开 | 允许（站长裁量），UI 提示 + 恢复默认可用 |
| 302 / 代理选择 | **行为不变**（决策 3：不改投送责任链） |

## 7. 分阶段实施建议（按决策收敛）

**P0（最小可用：先堵「配了不生效」+ 管理面越权）**

1. 新增 4 权限点（`media:play` / `notifications:read` / `system:settings` / `library:manage`），新增 `storage:browse_any`
2. `role_member` 权限集对齐（**保留 `storage:transfer`**，去掉 `assistant:chat`）
3. 页面守卫加权限判定：`/settings`、`/storage`、`/storage/strm` 三页 403 + 侧边栏过滤
4. 库管理接口接 `library:manage`（`POST /api/library`、`/api/library/[id]` 写方法、`/api/library/[id]/paths*`、`/api/library/items/*` 写方法、`POST /api/storage/scan`）
5. 门禁升级：`route-auth-inventory` 改为声明式权限表

**P1（网盘目录边界）**

1. `isWithinLibraryRoots` 纯函数 + `assertWithinLibraryRoots`
2. 接到 `listDirectory` 与全部写操作（含转存目标目录）
3. 驱动能力表：明确哪些品牌返回 breadcrumbs，其余 fail-closed

**P2（其余路由分批接权限）**

- 按 §3.2.3 的 B1–B4 分批，每批独立验收

**不做**：强制代理（决策 3）、带宽规划（决策 4）。

## 8. 决策记录（已定案，无需再确认）

| # | 决策 | 日期 |
| --- | --- | --- |
| 1 | 「影视库」禁止的是**管理面**，查看内容允许 | 2026-11-15 |
| 2 | 成员**保留「发起获取」** | 2026-11-15 |
| 3 | **强制代理功能不做**，保持按库规则播放 | 2026-11-15 |
| 4 | 服务器带宽预算**暂不考虑** | 2026-11-15 |

## 9. 参考来源

检索与核对日期：2026-11-15。优先官方文档与维护者仓库。

- [S1 Jellyfin — Managing Users](https://jellyfin.org/docs/general/server/users/adding-managing-users/)：逐库授权、「允许访问所有库」开关、新建库不自动授予。
- [S2 Jellyfin — Users](https://jellyfin.org/docs/general/server/users/)：每用户可配置项与权限粒度。
- [S3 Jellyfin Discussion #10028](https://github.com/orgs/jellyfin/discussions/10028)：库级授权的实际配置路径。
- [S4 Next.js — Authentication 官方指南](https://nextjs.org/docs/app/guides/authentication)：Server Component 做权限判定、Middleware 只做乐观检查。
- [S5 CVE-2025-29927（NVD）](https://nvd.nist.gov/vuln/detail/CVE-2025-29927)：Next.js middleware 可被 x-middleware-subrequest 绕过。
- [S6 Datadog Security Labs — 解析 CVE-2025-29927](https://securitylabs.datadoghq.com/articles/nextjs-middleware-auth-bypass/)：绕过机制与缓解。
- [S7 Casbin 官网](https://casbin.apache.org/)：ACL/RBAC/ABAC/ReBAC 统一模型与适用规模。
- [S8 SpiceDB vs Casbin（Authzed）](https://authzed.com/blog/casbin)：小项目用库、大项目用服务的选择依据。
- [S9 Permit — 2026 开源授权工具对比](https://www.permit.io/blog/top-open-source-authorization-tools-for-enterprises-in-2026)：主流方案与取舍。

本地设施核对（2026-11-15，基线 `24328515`）：[权限目录](../../packages/shared/src/auth/api-key-matrix.ts)、[内置角色](../../packages/shared/src/auth/rbac-matrix.ts#L70)、[细粒度守卫](../../apps/web/platform/next-context/auth-chain.ts#L225)、[路由鉴权清单门禁](../../apps/web/app/api/route-auth-inventory.test.ts)、[页面登录守卫](../../apps/web/platform/next-context/page-auth-guard.ts#L13)、[proxy 门禁](../../apps/web/proxy.ts#L63)、[侧边栏](../../apps/web/components/layout/app-sidebar.tsx#L99)、[网盘列表接口](../../apps/web/app/api/storage/files/route.ts#L155)、[目录列表](../../packages/workflow/src/storage/drive-file-manager.ts#L78)、[面包屑解析](../../packages/workflow/src/storage/pan115-cookie-client.ts#L180)、[投送责任链](../../packages/workflow/src/strm/strm-delivery.ts#L91)、[播放路由 delivery 参数](../../apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts#L411)、[播放器切换按钮](../../apps/web/features/player/components/mediary-player-modal.tsx#L144)、[存储域策略族](../../packages/workflow/src/domain/storage-scope-strategy.ts#L3)、[能力适配器](../../packages/workflow/src/domain/user-capability-adapter.ts)、[updateRole](../../packages/workflow/src/auth/role-store.ts#L113)。

## 10. 实施记录（2026-11-15，按四条决策落地）

### 10.1 权限目录与角色

| 变更 | 文件 |
| --- | --- |
| 新增 `media:play` / `library:manage` / `notifications:read` / `storage:browse_any` / `system:settings` | [api-key-matrix.ts](../../packages/shared/src/auth/api-key-matrix.ts) |
| `role_member` = 搜索 / 详情 / 订阅 / 播放 / 通知 / 浏览 / 转存 / 活动状态（**保留 storage:transfer**） | [rbac-matrix.ts](../../packages/shared/src/auth/rbac-matrix.ts) |
| `role_admin` 补 play / library:manage / notifications:read / browse_any / system:settings | 同上 |
| `role_bot` / `role_guest` 补 notifications:read 与 play 语义对齐 | 同上 |

### 10.2 页面守卫与侧边栏

- [page-permission-guard.ts](../../apps/web/platform/next-context/page-permission-guard.ts)：`PageAccess` / `hasPermission` / `decidePageAccess`（纯函数）+ `resolvePageAccess()`（接线）。**无权渲染 403 面板而不是 redirect**。
- [page-access-denied.tsx](../../apps/web/features/auth/components/page-access-denied.tsx)：403 页，区分「未登录」与「权限不足」并显示所需权限点。
- 页面接线：`/settings`（system:settings）、`/storage` 与 `/storage/strm`（storage:browse_any）；`/library` 允许进入但管理入口按 `library:manage` 隐藏。
- 侧边栏 [nav-visibility.ts](../../apps/web/features/auth/core/nav-visibility.ts) 纯映射（**不依赖 platform 层**，否则触发 feature-core-stays-pure），[lib/nav-visibility.ts](../../apps/web/lib/nav-visibility.ts) 负责读账号。

### 10.3 关键缺陷：单用户 + 已设密码会把站长判成成员

`resolveCookieContext` 过去调用 `getUserRole(accountId)` **不传 isOwnerFallback**，而该函数在 `customRoleId` 缺失时兜底 `role_member`。单用户 + 已设密码的实例走 cookie 路径 → 站长得不到 `role_owner` → 权限收敛上线后**站长把自己锁在设置页外面**。

修法：新增 `resolveAccountIsOwner()`（单用户恒 true，多用户读 `is_owner` 位），cookie 与 bearer 两条路径都把它传给 `getUserRole(accountId, isOwner)`。

### 10.4 网盘目录范围（需求 2）

- 纯函数 [library-scope.ts](../../packages/workflow/src/storage/library-scope.ts)：`isWithinLibraryRoots` / `libraryRootCids` / `assertWithinLibraryRoots`。**fail-closed**（无根集合或无面包屑都拒绝）。
- `libraryRootCids` **只取 movies/tv/anime，不含 rootCid**——否则成员能看到盘根下 `Mediary Scout/` 里的无关目录。
- 接线 [library-scope-guard.ts](../../apps/web/features/storage-drives/application/library-scope-guard.ts)：`assertListingInScope`（面包屑随列表返回，零额外调用）+ `assertDirectoryInScope`（写操作，目标恰是分类根时零调用）。
- 写接口全部接：`storage/files`（GET 判定范围）、`folder`/`copy`/`move`/`adopt`/`offline`（目标目录判定）、`delete`（改为 `storage:delete`）、`rename`（改为 `storage:organize`）。

### 10.5 门禁升级

- [route-permission-table.ts](../../apps/web/platform/next-context/route-permission-table.ts)：25 个已接线端点的声明式权限表 + `WIRED_ROUTE_COUNT` 评审锚点。
- [route-auth-inventory.test.ts](../../apps/web/app/api/route-auth-inventory.test.ts)：新增三条断言——清单端点必须**真的用声明的权限点字面量**调 `requirePermission`；清单权限点必须存在于目录；接线计数只增不减。
- [eslint-local-rules.mjs](../../tools/linter/eslint-local-rules.mjs)：`requirePermission` 视为登录链（它是超集，内部先 401 再判权限），避免同一请求解析两次安全上下文。

### 10.6 验证证据

- `npm run gate` **exit 0**（24 子门禁 + lint + typecheck）。
- 红绿验证三处：清单权限点写错 → 门禁红；`guardWriteTarget` 直通 → 范围测试红；Cookie-only 配额分支移除 → 诊断测试红。
- 未实施（按决策）：强制代理、带宽规划。

### 10.7 Dev 实机验证与一个诚实的说明

Dev 部署后（`24328515-dirty-175222`）实测：

- `/settings` 正常渲染（未 403）——**这是正确行为**：Dev 未设 `MEDIA_TRACK_MULTI_USER`，属单用户部署，账号即站长，权限面全开。单用户零摩擦这条红线在真实实例上成立。
- `/api/activity`、`/api/library`、`/api/storage/drives`、`/api/notifications/meta` 均 200。

**成员被拒这条路径没有在 Dev 上目视验证**：Dev 是单用户实例，不存在「标准成员」账号。成员侧的 403 目前只有两层证据：

1. 单元测试 `apps/web/tests/unit/auth/page-permission-guard.test.ts`（7 用例）——成员对 `system:settings` / `storage:browse_any` / `library:manage` 判 deny，对 `media:detail` / `storage:list` 判 allow；
2. 目录范围测试 `apps/web/tests/unit/storage/library-scope-guard.test.ts`（20 用例）——成员写媒体库根外目录抛 `OUTSIDE_LIBRARY_SCOPE`、写根内放行。

要目视验收成员面，需在 Dev 打开 `MEDIA_TRACK_MULTI_USER=1` 并创建一个非站长账号。这是**部署配置变更**（会重启容器），未擅自执行。

### 10.8 Dev 实机验收（成员角色，2026-11-15）

Dev 通过 `env/.envdev` 的 `DEV_MULTI_USER=1` / `DEV_MULTI_USER_MODE=shared` 开启多用户共用资源模式（**仅 Dev**；`deploy-remote.ps1` 现按 `DEV_*` / `PROD_*` 前缀隔离注入，生产不受影响）。用内置浏览器实测：

| 检查项 | 账号 | 实测 |
| --- | --- | --- |
| `/settings` 页面 | 成员 | 403 面板「权限不足 / 所需权限：system:settings」 |
| `/storage`、`/storage/strm` | 成员 | 403 面板「所需权限：storage:browse_any」 |
| `/library` | 成员 | 正常；**管理按钮全部不渲染**（新建库/立即扫描/库设置/批量管理） |
| `/notifications`、`/activity`、`/` | 成员 | 正常 |
| 侧边栏 | 成员 | 只剩 搜索/订阅/影视库/通知/活动（网盘、设置、助理隐藏） |
| 影视库可见性 | 成员 | 看到站长库的 11 个条目（shared 模式读侧归属站长） |
| 通知可见性 | 成员 | 看到站长的通知流（38 集 / 30 集入库） |
| `POST /api/library`、`POST /api/storage/scan` | 成员 | 403 `缺少 [library:manage]` |
| `POST /api/storage/files/delete`、`rename` | 成员 | 403 `缺少 [storage:delete]` / `[storage:organize]` |
| `/api/settings/{attention,users,roles,api-keys}` | 成员 | 403 `缺少 [system:settings]` |
| 目录范围：库内目录 | 成员 | 列表 200；建子目录 200（实际建成后由站长删除） |
| 目录范围：盘根 `dirId=0` | 成员 | 403 `OUTSIDE_LIBRARY_SCOPE` |
| 站长回归 | 站长 | `/settings`、`/storage` 正常；删除成员建的 probe 目录 200；库列表 11 条 |

### 10.9 验收期发现并修复的两个缺陷

**缺陷 1：shared 模式下读侧账号用错（会看到空壳）。**
`resolveGlobalWorkspace` / 页面库列表 / 通知 / 网盘凭据都直接用 `getCurrentAccountId()`，于是成员读的是自己的空账号：盘看不见、影视库空、连「验证目录范围」都因取不到凭据而 fail-closed。修法：新增 [lib/media-scope.ts](../../apps/web/lib/media-scope.ts)，接上早已存在但从未被消费的 `createStorageScopeStrategy()`；读写共用归属账号，**归属只决定"用哪块盘"，能不能做仍由权限与范围裁决**。

**缺陷 2：设置域 API 完全没接权限点。**
页面已 403，但 `/api/settings/*` 12 个路由仍只走登录链——成员可以直接 curl 改设置。修法：全部接 `requirePermission("system:settings")`，并登记进声明式权限表（25 → 37 端点）。

**验收方法学说明**：`/api/settings/users` 的成员列表在这里被用作"创建测试用户"的手段，但它本身受 `system:settings` 保护——成员拿不到，站长可以。
