import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getMultiUserMode,
  isSharedResourceMode,
  createStorageScopeStrategy,
  SingleUserStorageStrategy,
  IsolatedTenantStorageStrategy,
  SharedPoolStorageStrategy,
  UserCapabilityAdapter,
} from "../../src/index.js";

describe("StorageScopeStrategy & UserCapabilityAdapter", () => {
  const originalMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
  const originalMode = process.env.MEDIA_TRACK_MULTI_USER_MODE;

  afterEach(() => {
    if (originalMultiUser !== undefined) {
      process.env.MEDIA_TRACK_MULTI_USER = originalMultiUser;
    } else {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
    if (originalMode !== undefined) {
      process.env.MEDIA_TRACK_MULTI_USER_MODE = originalMode;
    } else {
      delete process.env.MEDIA_TRACK_MULTI_USER_MODE;
    }
  });

  describe("getMultiUserMode / isSharedResourceMode", () => {
    it("returns 'off' when MEDIA_TRACK_MULTI_USER is unset or not '1'", () => {
      delete process.env.MEDIA_TRACK_MULTI_USER;
      delete process.env.MEDIA_TRACK_MULTI_USER_MODE;
      expect(getMultiUserMode()).toBe("off");
      expect(isSharedResourceMode()).toBe(false);

      process.env.MEDIA_TRACK_MULTI_USER = "0";
      expect(getMultiUserMode()).toBe("off");
    });

    it("returns 'isolated' when MEDIA_TRACK_MULTI_USER=1 without shared mode", () => {
      process.env.MEDIA_TRACK_MULTI_USER = "1";
      delete process.env.MEDIA_TRACK_MULTI_USER_MODE;
      expect(getMultiUserMode()).toBe("isolated");
      expect(isSharedResourceMode()).toBe(false);

      process.env.MEDIA_TRACK_MULTI_USER_MODE = "isolated";
      expect(getMultiUserMode()).toBe("isolated");
      expect(isSharedResourceMode()).toBe(false);
    });

    it("returns 'shared' when MEDIA_TRACK_MULTI_USER=1 and MEDIA_TRACK_MULTI_USER_MODE=shared", () => {
      process.env.MEDIA_TRACK_MULTI_USER = "1";
      process.env.MEDIA_TRACK_MULTI_USER_MODE = "shared";
      expect(getMultiUserMode()).toBe("shared");
      expect(isSharedResourceMode()).toBe(true);
    });
  });

  describe("Strategy Scope Resolution", () => {
    it("SingleUserStorageStrategy maps everything to DEFAULT_ACCOUNT_ID", async () => {
      const strategy = new SingleUserStorageStrategy();
      const scope = await strategy.resolveMediaScope({
        requestAccountId: "acct_alice",
        explicitStorageId: "cs_1",
      });
      expect(scope).toEqual({
        targetAccountId: DEFAULT_ACCOUNT_ID,
        targetStorageId: "cs_1",
      });
      expect(strategy.canManageStorage()).toBe(true);
      expect(strategy.canDeleteMedia()).toBe(true);
    });

    it("IsolatedTenantStorageStrategy maps to requester account", async () => {
      const strategy = new IsolatedTenantStorageStrategy();
      const scope = await strategy.resolveMediaScope({
        requestAccountId: "acct_alice",
        explicitStorageId: "cs_alice_1",
      });
      expect(scope).toEqual({
        targetAccountId: "acct_alice",
        targetStorageId: "cs_alice_1",
      });
      expect(strategy.canManageStorage()).toBe(true);
      expect(strategy.canDeleteMedia()).toBe(true);
    });

    it("SharedPoolStorageStrategy maps all users to shared host account and restricts deletions", async () => {
      const strategy = new SharedPoolStorageStrategy(DEFAULT_ACCOUNT_ID);
      const scope = await strategy.resolveMediaScope({
        requestAccountId: "acct_bob",
        explicitStorageId: "cs_pool_1",
      });
      expect(scope).toEqual({
        targetAccountId: DEFAULT_ACCOUNT_ID,
        targetStorageId: "cs_pool_1",
      });

      // Regular user cannot delete media or manage storages
      expect(strategy.canManageStorage("acct_bob", false)).toBe(false);
      expect(strategy.canDeleteMedia("acct_bob", false)).toBe(false);

      // Owner can delete media and manage storages
      expect(strategy.canManageStorage("acct_bob", true)).toBe(true);
      expect(strategy.canDeleteMedia("acct_bob", true)).toBe(true);
    });

    it("createStorageScopeStrategy creates strategy matching mode", () => {
      expect(createStorageScopeStrategy("off")).toBeInstanceOf(SingleUserStorageStrategy);
      expect(createStorageScopeStrategy("isolated")).toBeInstanceOf(IsolatedTenantStorageStrategy);
      expect(createStorageScopeStrategy("shared")).toBeInstanceOf(SharedPoolStorageStrategy);
    });
  });

  describe("UserCapabilityAdapter", () => {
    it("provides full capabilities in single user mode", () => {
      const caps = UserCapabilityAdapter.getCapabilities({ id: "acct_1", isOwner: false }, "off");
      expect(caps.canManageDrives).toBe(true);
      expect(caps.canDeleteMedia).toBe(true);
      expect(caps.canRequest).toBe(true);
    });

    it("provides full personal capabilities in isolated multi user mode", () => {
      const regular = UserCapabilityAdapter.getCapabilities({ id: "acct_1", isOwner: false }, "isolated");
      expect(regular.canManageDrives).toBe(true);
      expect(regular.canDeleteMedia).toBe(true);
      expect(regular.canViewGlobalSettings).toBe(false);

      const owner = UserCapabilityAdapter.getCapabilities({ id: "acct_owner", isOwner: true }, "isolated");
      expect(owner.canViewGlobalSettings).toBe(true);
    });

    it("restricts destructive actions to owner in shared resource mode", () => {
      const regular = UserCapabilityAdapter.getCapabilities({ id: "acct_1", isOwner: false }, "shared");
      expect(regular.canRequest).toBe(true);
      expect(regular.canManageDrives).toBe(false);
      expect(regular.canDeleteMedia).toBe(false);
      expect(regular.canBypassApproval).toBe(false);
      expect(regular.dailyRequestQuota).toBe(10);

      const owner = UserCapabilityAdapter.getCapabilities({ id: "acct_owner", isOwner: true }, "shared");
      expect(owner.canRequest).toBe(true);
      expect(owner.canManageDrives).toBe(true);
      expect(owner.canDeleteMedia).toBe(true);
      expect(owner.canBypassApproval).toBe(true);
      expect(owner.dailyRequestQuota).toBe(Infinity);
    });
  });
});
