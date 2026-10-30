"use server";

import { revalidatePath } from "next/cache";
import { assertNotDemo } from "../../lib/demo-mode";

export interface TestStorageConnectionResult {
  ok: boolean;
  status: "active" | "frozen";
  message: string;
}

/** Settings "测试连接": probe a drive's cookie. A dead cookie freezes the drive
 *  (no acquisition/patrol until re-bound); a healthy one reactivates it. */
export async function testStorageConnectionAction(
  storageId: string,
): Promise<TestStorageConnectionResult> {
  assertNotDemo();
  const { testConnection, getCurrentAccountId } = await import("../../lib/workflow-runtime");
  const result = await testConnection(await getCurrentAccountId(), storageId);
  revalidatePath("/settings");
  return result;
}

export interface UnbindStorageActionResult {
  ok: boolean;
  message: string;
}

/** Settings「取消绑定」: hard-remove the drive from the account (frees the physical
 *  drive + drops its cookie), keeping tracking data so re-binding the same drive
 *  restores it. Refused while the drive has an in-flight acquisition. */
export async function unbindStorageAction(storageId: string): Promise<UnbindStorageActionResult> {
  assertNotDemo();
  const {
    requireAuthenticatedAccountId,
    getWorkflowRepository,
    clearPan115GlobalMirrorForUnboundDrive,
  } = await import("../../lib/workflow-runtime");
  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const repository = getWorkflowRepository();

  // Atomic ownership + active-run guard (closes TOCTOU between check and delete).
  const result = await repository.tryUnbindConnectedStorage(accountId, storageId);
  if (!result.ok) {
    if (result.reason === "active_runs") {
      return { ok: false, message: "该盘还有获取任务在进行，完成或取消后再取消绑定。" };
    }
    return { ok: false, message: "未找到该网盘。" };
  }

  // 刻意保留 `provider === "pan115"` 字面量，没有收成注册表能力旗。
  //
  // 这不是「按品牌分发到某段通用逻辑」（那类硬判才会在加新盘时静默走错分支），
  // 而是「这个品牌有没有一面需要收尾的全局镜像」。115 的实现本身深度耦合它自己
  // 的状态：PAN115_COOKIE_KEY / PAN115_META_KEY 两个设置键、parsePan115Uid、
  // 模块级 pan115CookieHydrated 水合标志、process.env.PAN115_COOKIE。
  //
  // 收成注册表能力只有两条路，都比现状差：加一个 hasGlobalMirror 布尔旗——看起来
  // 通用，但清理代码仍然只对 115 生效，新品牌翻了旗也不会被清理（假通用比显式
  // 特判更危险）；或者把 115 的 cookie 水合状态整个搬进共享注册表。
  //
  // 所以：显式特判 + 注释。将来真有第二家需要收尾，再把 onUnbind 能力连实现一起
  // 搬进注册表（那时才是真分发，不是旗子）。
  if (result.storage.provider === "pan115") {
    // Best-effort: unbind already committed; mirror cleanup must not fail the action.
    try {
      await clearPan115GlobalMirrorForUnboundDrive(result.storage.providerUid, repository);
    } catch {
      // leave stale mirror; next bind/unbind or cookie probe can reconcile
    }
  }

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, message: "已取消绑定（追踪记录已保留，重新绑定同一块盘即可恢复）。" };
}

export interface ConnectQuarkActionResult {
  ok: boolean;
  message: string;
}

/** Settings "添加网盘 → 115网盘": bind a pasted 115 cookie as a new drive. */
export async function connectPan115CookieAction(cookie: string): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  try {
    const { connectPan115Cookie } = await import("../../lib/workflow-runtime");
    const { providerUid } = await connectPan115Cookie(cookie);
    revalidatePath("/settings");
    return { ok: true, message: `115网盘已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Settings "添加网盘 → 夸克": bind a pasted 夸克 cookie as a new drive. */
export async function connectQuarkAction(cookie: string): Promise<ConnectQuarkActionResult> {
  return connectCloudFamilyCookieAction(cookie, "quark");
}

/** Settings "添加网盘 → UC网盘": bind a pasted UC cookie as a new drive. Same
 *  family protocol as 夸克, so it reuses the whole connect/probe/provision path. */
export async function connectUcAction(cookie: string): Promise<ConnectQuarkActionResult> {
  return connectCloudFamilyCookieAction(cookie, "uc");
}

/** Shared body for the 阿里云盘族 (夸克 / UC) cookie actions — the two differ only
 *  in which runtime function runs and the label in the success message. */
async function connectCloudFamilyCookieAction(
  cookie: string,
  provider: "quark" | "uc",
): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  const label = provider === "uc" ? "UC网盘" : "夸克网盘";
  try {
    const { connectQuarkCookie, connectUcCookie } = await import("../../lib/workflow-runtime");
    const { providerUid } = await (provider === "uc" ? connectUcCookie(cookie) : connectQuarkCookie(cookie));
    revalidatePath("/settings");
    return { ok: true, message: `${label}已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Settings "添加网盘 → 光鸭": bind a pasted access_token + refresh_token as a new
 *  drive. Mirrors connectQuarkAction; the token blob is validated + provisioned in
 *  connectGuangYa (workflow-runtime). */
export async function connectGuangYaAction(
  accessToken: string,
  refreshToken: string,
): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  try {
    const { connectGuangYa } = await import("../../lib/workflow-runtime");
    const { providerUid } = await connectGuangYa(accessToken, refreshToken);
    revalidatePath("/settings");
    return { ok: true, message: `光鸭云盘已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Settings "添加网盘 → 天翼": bind a pasted SSON cookie as a new drive. Mirrors
 *  connectGuangYaAction; the SSON is exchanged for a full session (personal +
 *  family credentials) + bound in connectTianyiSson (workflow-runtime). QR-scan
 *  binds via the /api/tianyi/qrcode/confirm route (completeTianyiQrLogin). */
export async function connectTianyiSsonAction(sson: string): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  try {
    const { connectTianyiSson } = await import("../../lib/workflow-runtime");
    const { providerUid } = await connectTianyiSson(sson);
    revalidatePath("/settings");
    return { ok: true, message: `天翼云盘已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Settings "添加网盘 → 123网盘": bind a pasted 90-day login token as a new drive.
 *  Mirrors connectTianyiSsonAction; the token is probed (listFiles on the root) +
 *  bound in connectPan123Token (workflow-runtime). QR-scan binds via the
 *  /api/pan123/qrcode/confirm route (completePan123QrLogin, Task 8). */
export async function connectPan123TokenAction(token: string): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  try {
    const { connectPan123Token } = await import("../../lib/workflow-runtime");
    const { providerUid } = await connectPan123Token(token);
    revalidatePath("/settings");
    return { ok: true, message: `123网盘已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
