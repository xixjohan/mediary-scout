import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 自助改密的服务端契约。
 *
 * 三条红线：
 *   1. 必须校验当前密码（自助改密不等于无凭据改密）；
 *   2. 改完删掉本人全部 session（其它设备掉线），但**不碰别人的**；
 *   3. 必须 bump 安全版本号——否则已签发的 API Key 在改密后仍然有效，
 *      那是一种"看着安全其实没关"的假象。
 *
 * ⚠️ 这些用例跑 scrypt（~50-80ms/次），显式放宽超时。
 */

const prevSqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const CRYPTO_TIMEOUT_MS = 30_000;

async function boot(multiUser: boolean) {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  if (multiUser) process.env.MEDIA_TRACK_MULTI_USER = "1";
  else delete process.env.MEDIA_TRACK_MULTI_USER;
  vi.resetModules();
  return import("../../../features/auth/application/account-service");
}

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevSqlitePath !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlitePath;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  else delete process.env.MEDIA_TRACK_MULTI_USER;
  vi.resetModules();
});

describe("changeOwnPassword（自助改密）", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it(
    "单用户首次设密免校验当前密码（只对单用户有意义）",
    async () => {
      const svc = await boot(false);
      const result = await svc.changeOwnPassword("acct_default", "", "newpass-1");
      expect(result.ok).toBe(true);
      const { getWorkflowRepository } = await import("../../../composition/runtime-container");
      const acct = await getWorkflowRepository().getAccountById("acct_default");
      expect(acct?.passwordHash.length).toBeGreaterThan(0);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "多用户：密码为空的账号拒绝免校验改密（提权口子必须堵）",
    async () => {
      const svc = await boot(true);
      // 该分支在多用户下曾是提权面：拿到 session 即可覆盖密码。
      const result = await svc.changeOwnPassword("acct_default", "", "newpass-1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("站长");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "当前密码错误 → 拒绝且不改库",
    async () => {
      const svc = await boot(true);
      const { getWorkflowRepository } = await import("../../../composition/runtime-container");
      const repo = getWorkflowRepository();
      await repo.adoptDefaultAccount({
        username: "owner_pw_probe",
        passwordHash: await (await import("@media-track/workflow")).hashPassword("old-pass-1"),
      });

      const wrong = await svc.changeOwnPassword("acct_default", "definitely-wrong", "new-pass-1");
      expect(wrong.ok).toBe(false);
      const right = await svc.changeOwnPassword("acct_default", "old-pass-1", "new-pass-1");
      expect(right.ok).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "改密后 bump 安全版本号（让已签发的 API Key 一并失效）",
    async () => {
      const svc = await boot(true);
      const { getWorkflowRepository, getUserManagementService } = await import("../../../composition/runtime-container");
      const repo = getWorkflowRepository();
      await repo.adoptDefaultAccount({
        username: "owner_secver_probe",
        passwordHash: await (await import("@media-track/workflow")).hashPassword("old-pass-1"),
      });
      const before = await getUserManagementService().getUserSecurityVersion("acct_default");

      const result = await svc.changeOwnPassword("acct_default", "old-pass-1", "new-pass-1");
      expect(result.ok).toBe(true);

      const after = await getUserManagementService().getUserSecurityVersion("acct_default");
      expect(after).toBe(before + 1);
    },
    CRYPTO_TIMEOUT_MS,
  );
});
