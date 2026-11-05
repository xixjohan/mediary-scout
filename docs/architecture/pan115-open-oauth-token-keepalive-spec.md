# 115 Open OAuth Token 保活机制：问题分析与解决方案

> 文档版本：v1.0 | 2026-11-04  
> 适用范围：`packages/workflow/src/storage/pan115-open-client.ts`、`apps/web/lib/background-worker.ts`、`apps/web/features/storage-drives/application/drive-service.ts`

> 实施说明（2026-11-05）：本文主体是初始方案草稿，部分示例仍使用旧的通用 `makeTokenPersister` 和“吞掉持久化错误”的行为，不可直接视为当前实现。当前修复结果、回归覆盖及跨进程限制见 [115 Open OAuth refresh token 失效调研](../research/pan115-open-oauth-refresh-token-expiry-investigation-2026-11-05.md)。

---

## 1. 问题现象

```
OAuth 轨 (清单/直链)
授权失效
OAuth 状态：已授权 (当前凭据不可用)
令牌剩余 TTL：已过期 (38 小时前，需重新授权)
错误: [115 Open API Error] code=40140120: refresh_token 无效
```

**现象**：Refresh Token 在用户长时间不使用系统时失效，每次恢复使用都需要重新扫码授权。

---

## 2. 根本原因分析

### 2.1 115 Open API Token 生命周期规则（官方）

| Token 类型 | 有效期 | 轮换策略 |
|-----------|--------|---------|
| `access_token` | **约 2 小时**（`expires_in = 7200`） | 每次刷新签发新值 |
| `refresh_token` | **约 30~60 天**（官方未公开精确值） | **一次性轮换（Rotation）**：每次使用后旧值立即作废，同时返回新值 |

> [!IMPORTANT]
> **Refresh Token 的核心特性：一次性轮换（One-Time Use Rotation）**
> 每次成功调用 `/open/refreshToken` 后，服务器会同时返回新的 `access_token` **和**新的 `refresh_token`，旧的 `refresh_token` 立即失效。
> 如果新 `refresh_token` 未被持久化，下次使用旧值将触发 `code=40140120`（防篡改校验失败）。

### 2.2 错误码语义

| 错误码 | 含义 | 可恢复性 |
|--------|------|---------|
| `40140115` | token 不存在（从未授权） | ❌ 致命，需重新授权 |
| `40140116` | refresh_token 已过期（超出最大生命周期） | ❌ 致命，需重新授权 |
| `40140119` | 用户已被踢出登录 | ❌ 致命，需重新授权 |
| `40140120` | **refresh_token 校验失败（防篡改/轮换未持久化）** | ❌ 致命，需重新授权 |
| `40140117` | 系统繁忙 | ✅ 可重试 |
| `40140121` | 刷新过于频繁（限流） | ✅ 退避重试 |

> [!WARNING]
> `40140120` 最常见于"**新 refresh_token 未被正确写回数据库**"，而不是真的 token 过期。这是轮换机制（Rotation）引发的持久化竞态问题。

### 2.3 "Refresh Token 过期"的真实根因树

```
Refresh Token 失效 (40140120 / 40140116)
├── A. 轮换未持久化（最常见）
│   ├── A1. 刷新成功但写库失败 → 旧 token 仍在 DB → 下次使用旧值触发 40140120
│   ├── A2. 并发刷新竞态 → 两个请求同时持有旧 token → 其中一个写库成功，另一个失效
│   └── A3. `onCredentialsPersist` 回调抛异常被静默吞掉 → DB 未更新
│
├── B. 长时间未刷新（refresh_token 超过最大生命周期，约 30~60 天）
│   └── 没有定时保活任务 → 系统静默期间 token 自然老化失效 → 40140116
│
└── C. 外部因素
    ├── 用户在 115 官网修改密码 / 撤销授权
    ├── 115 平台维护 / 策略调整
    └── 时钟偏差导致签名验证失败
```

### 2.4 当前系统现状（Gap 分析）

**已有的基础设施（✅ 现有）**：

| 组件 | 路径 | 功能 |
|------|------|------|
| `Pan115OpenClient.ensureValidToken()` | `packages/workflow/src/storage/pan115-open-client.ts:211` | 被动刷新：每次 API 调用前检查 `expiresAt`，提前 5 分钟刷新 |
| `SingleFlight` 防并发 | `pan115-open-client.ts:222` | 多个并发请求合并为单次刷新，避免惊群刷新导致 40140120 |
| `makeTokenPersister()` | `drive-service.ts:783` | 刷新成功后写回 SQLite 的回调 |
| `onCredentialsPersist` callback | `pan115-storage-factory.ts:129` | 工厂层注入 persist 回调到 `Pan115OpenClient` |
| `background-worker` | `apps/web/lib/background-worker.ts` | 每 3 秒轮询工作流队列 |
| 错误分类状态机 | `pan115-open-client.ts:39` | 致命/可重试错误准确区分 |

**缺失的组件（❌ Gap）**：

| 缺失 | 影响 |
|------|------|
| **无主动定时 Token 保活任务** | 长时间不使用（> 30 天）时 refresh_token 自然过期，下次启动无法自愈 |
| **`onCredentialsPersist` 失败不预警** | 写库失败被 `console.error` 静默处理，下次刷新使用旧 token 触发 40140120 |
| **没有 Token 过期预警通知** | 用户不知道 token 即将过期，直到完全失效才弹错误 |

---

## 3. 业界主流方案对比

### 3.1 LitePan（Go 参考实现，`LitePan-main/internal/auth/`）

LitePan 实现了完整的 **双轨认证调度器**，分为主动刷新（`CallerActive`）和被动刷新（`CallerPassive`）：

```go
// refresh_runner.go - 认证调度器
type RefreshCaller int
const (
    CallerActive  RefreshCaller = iota  // 定时主动调度
    CallerPassive                        // 被动请求拦截（请求失败后触发）
)

// 主动刷新：在 token 到期前 N 分钟主动刷新，无需等到 access_token 失效
// 被动刷新：API 请求失败（401）时触发，作为兜底
func (s *Service) Refresh(ctx, accountID, caller) {
    ctx, unlock, _ = s.lockAccount(ctx, accountID)  // per-account 锁，防并发
    defer unlock()
    if recentlyRefreshed(st, s.now()) { return RefreshSuccess }  // 防重复刷新
    return s.refreshUnlocked(...)
}
```

关键特性：
- **per-account 锁**：同一账号刷新互斥，防止 rotation 竞态
- **主动+被动双轨**：主动调度定时刷新，被动兜底请求失败时刷新
- **`recentlyRefreshed` 防抖**：短时间内已刷新则跳过
- **`TokenLifetime` 配置驱动**：每个驱动可配置 token 生命周期和检查间隔

### 3.2 AList（Go，另一主流实现）

AList 使用简单的定时器 + 被动刷新：
- 每个 driver 注册 `RefreshToken()` 方法
- 全局 goroutine 每 N 分钟遍历所有已连接账号
- access_token `expiresAt` 前 10 分钟触发刷新

### 3.3 Mediary Scout 现有方案定位

Mediary Scout 目前是**纯被动刷新**（on-demand）：
- 每次 API 调用时检查 `expiresAt`
- access_token 过期前 5 分钟触发刷新
- SingleFlight 防并发

**缺少的是主动保活（Proactive Keep-Alive）**：当系统长时间无 115 API 调用时，refresh_token 超过平台最大生命周期后自然失效。

---

## 4. 解决方案

### 方案设计：在 Background Worker 中注入 Token 保活任务

**核心思路**：复用已有的 `background-worker` 定时轮询机制（每 3 秒一次），在每次 tick 中检查所有已连接的 115 Open OAuth 账号，若 `expiresAt` 在 1 小时内到期则主动刷新。

```
background-worker tick (每3秒)
├── drainQueue()          ← 现有：工作流队列消费
├── runScheduled()        ← 现有：每日巡检
├── runDueStrmTasks()     ← 现有：STRM 定时扫描
├── autoUpdate()          ← 现有：自动更新检查
└── runTokenKeepAlive()   ← 新增：115 Open OAuth Token 保活
    ├── 查询所有 provider=pan115 且有 openOAuth 的 ConnectedStorage
    ├── 过滤 expiresAt < now + 60分钟 的账号
    ├── 对每个账号调用 Pan115OpenClient.ensureValidToken()
    │   └── 刷新成功 → onCredentialsPersist → makeTokenPersister → upsert DB
    └── 刷新失败(致命) → 写入 notifications 表，提示用户重新授权
```

### 4.1 新增文件：`apps/web/lib/pan115-token-keepalive.ts`

```typescript
/**
 * 115 Open OAuth Token 主动保活模块
 * 
 * 职责：在 background-worker 每次 tick 中检查所有 115 Open OAuth 账号，
 * 当 access_token 临近过期（< 60 分钟）时主动刷新，确保 refresh_token 轮换
 * 被正确持久化，避免长时间不使用导致的 token 自然老化失效。
 */

import type { WorkflowRepository, Pan115OpenOAuthCredentials } from "@media-track/workflow";
import { Pan115OpenClient, classify115OpenError } from "@media-track/workflow";
import { makeTokenPersister } from "../features/storage-drives/application/drive-service";
import { DEFAULT_ACCOUNT_ID } from "@media-track/contracts";

/** 主动刷新提前量：access_token 有效期少于此值时触发刷新 */
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 小时

/** 防止同一账号连续刷新：两次成功刷新之间最短间隔 */
const MIN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

/** 记录上次刷新时间（内存防抖，单进程内有效） */
const lastRefreshedAt = new Map<string, number>();

export interface TokenKeepAliveResult {
  checked: number;    // 检查的账号数
  refreshed: number;  // 成功刷新的账号数
  failed: number;     // 刷新失败（非致命）的账号数
  fatal: number;      // 致命失败（需重新授权）的账号数
}

export async function runPan115TokenKeepAlive(
  repository: WorkflowRepository,
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<TokenKeepAliveResult> {
  const result: TokenKeepAliveResult = { checked: 0, refreshed: 0, failed: 0, fatal: 0 };
  const now = Date.now();

  const storages = await repository.listConnectedStorages(accountId);
  const pan115WithOAuth = storages.filter((s) => {
    if (s.provider !== "pan115") return false;
    const payload = s.payload as Record<string, unknown> | null;
    const openOAuth = payload?.openOAuth as Pan115OpenOAuthCredentials | undefined;
    return openOAuth?.accessToken && openOAuth?.refreshToken;
  });

  for (const storage of pan115WithOAuth) {
    result.checked++;
    const payload = storage.payload as Record<string, unknown>;
    const openOAuth = payload.openOAuth as Pan115OpenOAuthCredentials;

    // 防抖：30 分钟内刚刷新过的跳过
    const lastAt = lastRefreshedAt.get(storage.id) ?? 0;
    if (now - lastAt < MIN_REFRESH_INTERVAL_MS) continue;

    // 检查是否需要刷新（< 1 小时到期）
    const timeUntilExpiry = openOAuth.expiresAt - now;
    if (timeUntilExpiry > PROACTIVE_REFRESH_THRESHOLD_MS) continue;

    try {
      const client = new Pan115OpenClient({
        credentials: openOAuth,
        onCredentialsPersist: makeTokenPersister(accountId, storage.id, storage.provider),
      });
      await client.ensureValidToken();
      lastRefreshedAt.set(storage.id, now);
      result.refreshed++;
      console.log(
        `[token-keepalive] 115 Open OAuth for ${storage.id} refreshed proactively ` +
        `(was ${Math.round(timeUntilExpiry / 60000)} min from expiry)`
      );
    } catch (err) {
      const isFatal = err instanceof Error && "isFatal" in err && Boolean((err as any).isFatal);
      if (isFatal) {
        result.fatal++;
        console.error(
          `[token-keepalive] FATAL: 115 Open OAuth for ${storage.id} requires re-authorization:`, err
        );
        // TODO: 写入 notifications 表通知用户重新授权
      } else {
        result.failed++;
        console.warn(`[token-keepalive] transient refresh failure for ${storage.id}:`, err);
      }
    }
  }

  return result;
}
```

### 4.2 修改 `background-worker.ts`：注入保活 hook

```typescript
// 在 DrainDeps 接口中添加
export interface DrainDeps {
  // ...现有字段...
  /** 主动 Token 保活检查（115 Open OAuth）。Optional，缺席时跳过。 */
  runTokenKeepAlive?: (() => Promise<void>) | undefined;
}

// 在 drainQueueOnce() 中添加
export async function drainQueueOnce(deps: DrainDeps): Promise<number> {
  // ...现有逻辑...
  if (deps.runTokenKeepAlive) {
    try {
      await deps.runTokenKeepAlive();
    } catch (error) {
      console.error(`[background-worker] token keep-alive failed:`, error);
    }
  }
  // ...
}
```

### 4.3 修改 `workflow-runtime.ts`：挂载保活到 WorkerRuntime

```typescript
// defaultRuntime() 中添加
export async function defaultRuntime(): Promise<WorkerRuntime> {
  const { runPan115TokenKeepAlive } = await import("./pan115-token-keepalive");
  const repository = getWorkflowRepository();
  
  return {
    // ...现有字段...
    runTokenKeepAlive: async () => {
      const result = await runPan115TokenKeepAlive(repository);
      if (result.fatal > 0) {
        console.error(`[token-keepalive] ${result.fatal} account(s) need re-authorization`);
      }
    },
  };
}
```

---

## 5. `onCredentialsPersist` 失败预警加固

**现有代码**（`pan115-open-client.ts:238`）：

```typescript
// 现有：失败被静默吞掉
if (this.onCredentialsPersist) {
  try {
    await this.onCredentialsPersist({ ...this.credentials });
  } catch (err) {
    console.error("[Pan115OpenClient] Failed to persist refreshed token:", err);
    // ← 这里只 console.error，程序继续，但 DB 未更新！
    // 下次用旧 refresh_token 刷新 → 40140120
  }
}
```

**建议加固**（不影响现有签名）：

```typescript
if (this.onCredentialsPersist) {
  try {
    await this.onCredentialsPersist({ ...this.credentials });
  } catch (err) {
    // 持久化失败是高危事件：在内存中标记需要重试，并在下次请求前再次尝试持久化
    this._pendingPersist = { ...this.credentials };
    console.error("[Pan115OpenClient] CRITICAL: Failed to persist refreshed token. " +
      "New refresh_token is in memory but not in DB. Will retry on next request:", err);
  }
}
```

---

## 6. 通知系统：Token 过期预警

在 `runPan115TokenKeepAlive()` 中，当致命错误发生时，应写入通知：

```typescript
// 伪代码：写入 notifications 表
await repository.createNotification({
  type: "auth_expired",
  title: "115 Open OAuth 授权已失效",
  message: `网盘 ${storage.label}（${storage.id}）的 refresh_token 已被 115 服务器注销，请前往「设置 → 网盘」重新扫码授权。`,
  storageId: storage.id,
  createdAt: new Date().toISOString(),
});
```

---

## 7. 实施优先级与路线图

| 优先级 | 任务 | 预估工时 | 影响 |
|--------|------|----------|------|
| P0 🔴 | `onCredentialsPersist` 失败预警 + 内存重试 | 1h | 防止轮换竞态导致的 40140120 |
| P0 🔴 | `pan115-token-keepalive.ts` 主动保活 | 2h | 防止 refresh_token 长期不用自然过期 |
| P1 🟡 | 注入到 `background-worker` 和 `defaultRuntime` | 1h | 完整闭环 |
| P1 🟡 | 写入 notifications 表 | 1h | 用户友好预警 |
| P2 🟢 | 保活结果写入活动日志 | 0.5h | 可观测性 |
| P2 🟢 | 设置页添加"手动刷新 Token"按钮 | 1h | 应急操作 |

---

## 8. 门禁：同类回归测试

### 8.1 `pan115-token-keepalive.test.ts`

```typescript
// 应覆盖的测试用例
describe("runPan115TokenKeepAlive", () => {
  it("skip accounts with token valid > 60 minutes", async () => { /* ... */ });
  it("refresh accounts with token expiring < 60 minutes", async () => { /* ... */ });
  it("persist new credentials to DB after refresh", async () => { /* ... */ });
  it("debounce: skip accounts refreshed < 30 minutes ago", async () => { /* ... */ });
  it("handle fatal error (40140120) without throwing", async () => { /* ... */ });
  it("handle retryable error (40140121) without throwing", async () => { /* ... */ });
  it("SingleFlight prevents concurrent refresh for same account", async () => { /* ... */ });
  it("persist failure should NOT throw and should log CRITICAL", async () => { /* ... */ });
});
```

### 8.2 `pan115-open-client.test.ts` 补充

```typescript
// 应补充的测试用例
describe("onCredentialsPersist", () => {
  it("persist is called with new refresh_token after rotation", async () => { /* ... */ });
  it("persist failure does not throw from ensureValidToken", async () => { /* ... */ });
  it("in-memory credentials are updated even if persist fails", async () => { /* ... */ });
});
```

### 8.3 质量门禁检查项（CI）

```bash
# 1. 确保 TokenKeepAlive 不引入新的 complexity 超限
node scripts/gate-code-limits.mjs

# 2. ESLint + no-floating-promises（保活中的 async 操作不能 fire-and-forget）
npm run lint

# 3. TypeScript 严格模式（exactOptionalPropertyTypes）
npm run typecheck

# 4. 确保没有 native confirm/alert（gate:modals）
node scripts/gate-modals.mjs

# 5. 单元测试覆盖保活模块
npx vitest run apps/web/lib/pan115-token-keepalive.test.ts
```

---

## 9. 参考资料

| 来源 | 路径 | 关键实现 |
|------|------|---------|
| LitePan 115驱动 | `drivers/115_Open/auth.go` | `classifyRefreshError`、`exchangeToken`（含持久化） |
| LitePan 认证调度器 | `internal/auth/refresh_runner.go` | `Refresh`、`CallerActive`/`CallerPassive` 双轨 |
| LitePan 刷新接口 | `internal/driver/refresh.go` | `AuthRefresher` 接口定义 |
| 当前实现 | `packages/workflow/src/storage/pan115-open-client.ts` | `ensureValidToken`、`SingleFlight`、`onCredentialsPersist` |
| 持久化回调 | `apps/web/features/storage-drives/application/drive-service.ts:783` | `makeTokenPersister` |
| Background Worker | `apps/web/lib/background-worker.ts` | `drainQueueOnce`、`startBackgroundWorker` |
