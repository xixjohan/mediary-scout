import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryWorkflowRepository,
  type UpsertConnectedStorageInput,
} from "@media-track/workflow";
import {
  diagnoseStorageConnectionAction,
  checkAccountHasPasswordAction,
  revealStorageCredentialAction,
} from "../../../app/actions/storage-drives-actions";
import { setWorkflowRepositoryForTest } from "../../../lib/workflow-runtime";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function testDualEngineDrive(over: Partial<UpsertConnectedStorageInput> = {}): UpsertConnectedStorageInput {
  return {
    id: "cs_115_dual",
    accountId: "acct_default",
    provider: "pan115",
    providerUid: "115_uid_test",
    label: "115双轨",
    payload: {
      cookie: "UID=115001; CID=c1; SEID=seid_secret_123",
      openOAuth: {
        accessToken: "at_test_token_123",
        refreshToken: "rt_test_token_456",
        expiresAt: Date.now() + 3600 * 1000,
        clientId: "client_id_test",
      },
    },
    rootCid: "r1",
    moviesCid: "m1",
    tvCid: "t1",
    animeCid: "a1",
    createdAt: "2026-06-20T00:00:00.000Z",
    ...over,
  };
}

describe("diagnoseStorageConnectionAction & revealStorageCredentialAction", () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepositoryForTest(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("diagnoseStorageConnectionAction reports dual_engine mode and routing strategy", async () => {
    await repo.upsertConnectedStorage(testDualEngineDrive());

    const res = await diagnoseStorageConnectionAction("cs_115_dual");
    expect(res.ok).toBe(true);
    expect(res.report?.engineMode).toBe("dual_engine");
    expect(res.report?.cookieStatus.configured).toBe(true);
    expect(res.report?.openOAuthStatus?.configured).toBe(true);
    expect(res.report?.routingSummary.transferEngine).toBe("cookie");
    expect(res.report?.routingSummary.listingEngine).toBe("open");
    expect(res.report?.routingSummary.streamEngine).toBe("open");
  });

  it("diagnoseStorageConnectionAction reports expired TTL and error when openOAuth is expired", async () => {
    const expiredDrive = testDualEngineDrive({
      id: "cs_115_expired",
      payload: {
        cookie: "UID=115001; CID=c1; SEID=seid_secret_123",
        openOAuth: {
          accessToken: "at_expired_token",
          refreshToken: "rt_invalid_token",
          expiresAt: Date.now() - 3600 * 1000 * 24,
          clientId: "client_id_test",
        },
      },
    });
    await repo.upsertConnectedStorage(expiredDrive);

    const res = await diagnoseStorageConnectionAction("cs_115_expired");
    expect(res.ok).toBe(true);
    expect(res.report?.openOAuthStatus?.configured).toBe(true);
    expect(res.report?.openOAuthStatus?.valid).toBe(false);
    expect(res.report?.openOAuthStatus?.error).toBeDefined();
    expect(res.report?.openOAuthStatus?.expiresInSec).toBeDefined();
    expect(res.report?.openOAuthStatus?.expiresInSec).toBeLessThan(0);
  });

  it("diagnoseStorageConnectionAction for quark does not report openOAuth and sets supportsOpenOAuth to false", async () => {
    await repo.upsertConnectedStorage({
      id: "cs_quark_test",
      accountId: "acct_default",
      provider: "quark",
      providerUid: "quark_uid_123",
      label: "夸克网盘",
      payload: {
        cookie: "test_cookie=abc; __uid=123",
      },
      rootCid: "r_quark",
      moviesCid: "m_quark",
      tvCid: "t_quark",
      animeCid: "a_quark",
      createdAt: "2026-06-20T00:00:00.000Z",
    });

    const res = await diagnoseStorageConnectionAction("cs_quark_test");
    expect(res.ok).toBe(true);
    expect(res.report?.supportsOpenOAuth).toBe(false);
    expect(res.report?.authKind).toBe("cookie");
    expect(res.report?.openOAuthStatus).toBeUndefined();
    expect(res.report?.engineMode).toBeUndefined();
    expect(res.report?.cookieStatus.configured).toBe(true);
    expect(res.report?.routingSummary.transferEngine).toBe("cookie");
    expect(res.report?.routingSummary.listingEngine).toBe("cookie");
    expect(res.report?.routingSummary.streamEngine).toBe("cookie");
  });


  it("checkAccountHasPasswordAction returns false for default single user with no password", async () => {
    const hasPassword = await checkAccountHasPasswordAction();
    expect(hasPassword).toBe(false);
  });

  it("revealStorageCredentialAction reveals decrypted credentials in single user mode", async () => {
    await repo.upsertConnectedStorage(testDualEngineDrive());

    const res = await revealStorageCredentialAction("cs_115_dual");
    expect(res.ok).toBe(true);
    expect(res.credentials?.provider).toBe("pan115");
    expect(res.credentials?.cookie).toBe("UID=115001; CID=c1; SEID=seid_secret_123");
    expect(res.credentials?.openOAuth?.accessToken).toBe("at_test_token_123");
    expect(res.credentials?.openOAuth?.refreshToken).toBe("rt_test_token_456");
  });

  it("revealStorageCredentialAction returns error when storage does not exist", async () => {
    const res = await revealStorageCredentialAction("cs_non_existent");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("不存在");
  });

  it("revealStorageCredentialAction enforces password check when account has password", async () => {
    const { hashPassword } = await import("@media-track/workflow");
    await repo.createAccount({
      id: "acct_default",
      username: "admin",
      passwordHash: await hashPassword("mySecretPass123"),
      groupId: null,
      isOwner: true,
      createdAt: new Date().toISOString(),
    });
    await repo.upsertConnectedStorage(testDualEngineDrive());

    // 1. 无密码或错密码被拦截
    const failNoPass = await revealStorageCredentialAction("cs_115_dual");
    expect(failNoPass.ok).toBe(false);
    expect(failNoPass.error).toContain("请输入账户密码");

    const failWrongPass = await revealStorageCredentialAction("cs_115_dual", "wrong_password");
    expect(failWrongPass.ok).toBe(false);
    expect(failWrongPass.error).toContain("密码验证不正确");

    // 2. 正确密码通过解密
    const successPass = await revealStorageCredentialAction("cs_115_dual", "mySecretPass123");
    expect(successPass.ok).toBe(true);
    expect(successPass.credentials?.cookie).toContain("UID=115001");
  });
});
