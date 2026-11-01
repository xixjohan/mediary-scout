import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveLibraryDirNaming,
  LIBRARY_ROOT_DIR_SETTING_KEY,
  LIBRARY_MOVIES_DIR_SETTING_KEY,
  DEFAULT_LIBRARY_ROOT_DIR,
  DEFAULT_LIBRARY_MOVIES_DIR,
} from "./settings-readers";
import { ProxyManager, resolveMergedNoProxy } from "../../features/settings-system/core/http-proxy";
import {
  resolveInternalWorkerSecret,
  workerApiGuard,
  _resetWorkerSecretCacheForTesting,
} from "../../platform/next-context/worker-api-guard";
import { NextRequest } from "next/server";

describe("Configuration Evolution and Governance", () => {
  describe("Library Directory Naming Resolution (Multi-Tier Cascading Strategy)", () => {
    it("falls back to factory defaults when DB and env are empty", async () => {
      const repo = {
        getSetting: vi.fn().mockResolvedValue(null),
        getAccountSetting: vi.fn().mockResolvedValue(null),
      };
      const res = await resolveLibraryDirNaming(repo, "acct_test", {});
      expect(res.rootName).toBe(DEFAULT_LIBRARY_ROOT_DIR);
      expect(res.moviesName).toBe(DEFAULT_LIBRARY_MOVIES_DIR);
      expect(res.tvName).toBe("TV");
      expect(res.animeName).toBe("Anime");
    });

    it("prioritizes account-level setting over global setting and env", async () => {
      const repo = {
        getSetting: vi.fn().mockImplementation(async (key: string) => {
          if (key === LIBRARY_ROOT_DIR_SETTING_KEY) return "Global Root";
          return null;
        }),
        getAccountSetting: vi.fn().mockImplementation(async (_acc: string, key: string) => {
          if (key === LIBRARY_ROOT_DIR_SETTING_KEY) return "User Root";
          return null;
        }),
      };
      const env = { MEDIA_TRACK_LIBRARY_ROOT_DIR: "Env Root" };
      const res = await resolveLibraryDirNaming(repo, "acct_1", env);
      expect(res.rootName).toBe("User Root");
    });

    it("falls back to global app setting when account has no override", async () => {
      const repo = {
        getSetting: vi.fn().mockImplementation(async (key: string) => {
          if (key === LIBRARY_MOVIES_DIR_SETTING_KEY) return "定制电影";
          return null;
        }),
        getAccountSetting: vi.fn().mockResolvedValue(null),
      };
      const res = await resolveLibraryDirNaming(repo, "acct_1", {});
      expect(res.moviesName).toBe("定制电影");
    });

    it("honors per-storage override above all else", async () => {
      const repo = {
        getSetting: vi.fn().mockResolvedValue("Global"),
        getAccountSetting: vi.fn().mockResolvedValue("Account"),
      };
      const res = await resolveLibraryDirNaming(repo, "acct_1", {}, {
        rootName: "Storage Override",
      });
      expect(res.rootName).toBe("Storage Override");
    });
  });

  describe("Outbound Proxy Manager & NoProxy Merging", () => {
    it("automatically merges domestic drive domains into NO_PROXY", () => {
      const merged = resolveMergedNoProxy("custom.domain.local");
      expect(merged).toContain("115.com");
      expect(merged).toContain("quark.cn");
      expect(merged).toContain("123pan.com");
      expect(merged).toContain("custom.domain.local");
    });

    it("reloads proxy configuration gracefully", async () => {
      const manager = new ProxyManager();
      const res = await manager.reload({
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "internal.lan",
      });
      expect(res.enabled).toBe(true);
      expect(res.proxyDisplay).toBe("127.0.0.1:7890");

      const revertRes = await manager.reload({ httpProxy: "" });
      expect(revertRes.enabled).toBe(false);
    });
  });

  describe("Worker Api Guard Auto-Provisioning", () => {
    const origSecret = process.env.MEDIA_TRACK_WORKER_SECRET;
    const origMulti = process.env.MEDIA_TRACK_MULTI_USER;

    beforeEach(() => {
      _resetWorkerSecretCacheForTesting();
      delete process.env.MEDIA_TRACK_WORKER_SECRET;
      delete process.env.MEDIA_TRACK_MULTI_USER;
    });

    afterEach(() => {
      _resetWorkerSecretCacheForTesting();
      if (origSecret !== undefined) process.env.MEDIA_TRACK_WORKER_SECRET = origSecret;
      else delete process.env.MEDIA_TRACK_WORKER_SECRET;
      if (origMulti !== undefined) process.env.MEDIA_TRACK_MULTI_USER = origMulti;
      else delete process.env.MEDIA_TRACK_MULTI_USER;
    });

    it("auto-provisions or discovers internal token safely", () => {
      process.env.MEDIA_TRACK_WORKER_SECRET = "test_secret_123";
      expect(resolveInternalWorkerSecret()).toBe("test_secret_123");
    });

    it("rejects unauthorized calls when secret is provisioned", () => {
      process.env.MEDIA_TRACK_WORKER_SECRET = "secret_guard_check";
      const req = new NextRequest("http://127.0.0.1:3000/api/workflows/run-next", {
        headers: { "x-media-track-worker-secret": "wrong" },
      });
      const denied = workerApiGuard(req);
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(401);
    });

    it("passes authorized calls when correct secret is supplied", () => {
      process.env.MEDIA_TRACK_WORKER_SECRET = "secret_guard_check";
      const req = new NextRequest("http://127.0.0.1:3000/api/workflows/run-next", {
        headers: { "x-media-track-worker-secret": "secret_guard_check" },
      });
      const denied = workerApiGuard(req);
      expect(denied).toBeNull();
    });
  });
});
