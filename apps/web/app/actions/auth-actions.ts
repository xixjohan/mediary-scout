"use server";

import { assertNotDemo } from "../../lib/demo-mode";
import type { ConnectLoginActionResult, TestRemoteAccessResult } from "../../features/auth/contracts/auth-tokens";

/** Self-service password change (multi-user). Verifies the current password,
 *  rotates the hash, revokes all sessions (caller must re-login). */
export async function changePasswordAction(
  current: string,
  next: string,
): Promise<{ ok: boolean; error?: string }> {
  assertNotDemo();
  const { getCurrentAccountId, changeOwnPassword } = await import("../../lib/workflow-runtime");
  return changeOwnPassword(await getCurrentAccountId(), current, next);
}

/** Owner-only reset of another account's password. The owner check is enforced
 *  inside resetUserPassword (server-side, not just hidden UI). */
export async function resetUserPasswordAction(
  targetAccountId: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  assertNotDemo();
  const { getCurrentAccountId, resetUserPassword } = await import("../../lib/workflow-runtime");
  return resetUserPassword(await getCurrentAccountId(), targetAccountId, newPassword);
}

export interface ConnectLoginActionResult {
  ok: boolean;
  message: string;
}

/**
 * 在设置页内发起 Mediary Connect 登录(发一封魔法链接邮件)。
 *
 * 走 server action 而不是浏览器直接 fetch:worker 不发 CORS 头,
 * 跨域 POST 会被预检拦掉。理由详见 lib/remote-access.ts 的 requestConnectLogin。
 *
 * demo 站禁用 —— 只读演示没有自己的实例,开通远程访问没有意义。
 */
export async function requestConnectLoginAction(email: string): Promise<ConnectLoginActionResult> {
  assertNotDemo();
  const { requestConnectLogin } = await import("../../lib/remote-access");
  return await requestConnectLogin(email);
}

// tagged union 而非 { ok: boolean; detail: ... }(Copilot 意见):
// 后者允许 { ok: true, detail: "unreachable" } 这种不可能组合编译通过。
// 判别字段 detail 与 ok 一一对应,不可能状态在类型层面就不存在。


/**
 * 远程访问「测试连接」。
 *
 * 探测 https://<hostname>/api/health(实例自己的健康端点,匿名可达)。
 * 走服务端:浏览器直连会撞 CORS,且 hostname 在 .env 里只有服务端读得到。
 *
 * 语义:
 * - reachable:隧道通、实例健康
 * - instance_problem:503 —— 隧道通但实例内部有问题(该查实例不是隧道)
 * - unreachable:超时/网络错/其它状态码
 * - no_hostname:老实例 .env 没有 MEDIARY_CONNECT_HOSTNAME,没法探测
 */
export async function testRemoteAccessConnectionAction(): Promise<TestRemoteAccessResult> {
  // demo gate:与其它 settings action 一致(Copilot round 1)。
  // demo 站没有真实隧道,探测只会做无意义的跨网请求。
  assertNotDemo();
  const { resolveInstanceConnectHostname } = await import("../../lib/remote-access");
  const hostname = await resolveInstanceConnectHostname();
  if (hostname === null) {
    return { ok: false, detail: "no_hostname" };
  }
  const { probeRemoteAccess } = await import("../../lib/remote-access-probe");
  return await probeRemoteAccess(hostname);
}
