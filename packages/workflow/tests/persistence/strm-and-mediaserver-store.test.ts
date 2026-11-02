import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteWorkflowRepository,
  InMemoryWorkflowRepository,
  type SqliteWorkflowRepository,
} from "../../src/index.js";

describe("StrmStore & MediaServerStore", () => {
  const dirs: string[] = [];
  const repos: SqliteWorkflowRepository[] = [];

  const tmpDb = () => {
    const dir = mkdtempSync(join(tmpdir(), "strm-store-"));
    dirs.push(dir);
    return join(dir, "mediary.db");
  };

  const createRepo = (path: string) => {
    const repo = createSqliteWorkflowRepository({ path });
    repos.push(repo);
    return repo;
  };

  afterEach(() => {
    for (const r of repos.splice(0)) {
      try {
        r.close();
      } catch {}
    }
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  describe("SqliteWorkflowRepository (SQLite Engine)", () => {
    it("creates, updates, lists and deletes STRM tasks", async () => {
      const path = tmpDb();
      const repo = createRepo(path);

      const task = await repo.createStrmTask({
        accountId: "acct_test",
        name: "115 Movies STRM",
        storageId: "cs_115",
        remoteFolderId: "cid_123",
        remotePath: "/Media/Movies",
        localOutputDir: "/data/strm/movies",
        scanMode: "incremental_missing",
      });

      expect(task.id).toBeDefined();
      expect(task.status).toBe("idle");
      expect(task.scanIntervalMinutes).toBe(360);

      const list = await repo.listStrmTasks("acct_test");
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(task.id);

      const updated = await repo.updateStrmTask({
        id: task.id,
        accountId: "acct_test",
        status: "running",
        lastScanStatus: "in_progress",
      });

      expect(updated?.status).toBe("running");
      expect(updated?.lastScanStatus).toBe("in_progress");

      const fetched = await repo.getStrmTask(task.id, "acct_test");
      expect(fetched?.status).toBe("running");

      const deleted = await repo.deleteStrmTask(task.id, "acct_test");
      expect(deleted).toBe(true);
      expect(await repo.getStrmTask(task.id, "acct_test")).toBeNull();
    });

    it("persists deliveryMode ('redirect' vs 'proxy') and supports dynamic schema upgrade", async () => {
      const path = tmpDb();
      const repo = createRepo(path);

      // 1. 创建带 proxy 模式的任务
      const proxyTask = await repo.createStrmTask({
        accountId: "acct_mode",
        name: "Quark Proxy Task",
        storageId: "cs_quark",
        remoteFolderId: "f_quark",
        remotePath: "/Quark/Movies",
        localOutputDir: "/data/strm/quark",
        deliveryMode: "proxy",
      });
      expect(proxyTask.deliveryMode).toBe("proxy");

      const fetchedProxy = await repo.getStrmTask(proxyTask.id, "acct_mode");
      expect(fetchedProxy?.deliveryMode).toBe("proxy");

      // 2. 修改模式为 redirect
      const updatedToRedirect = await repo.updateStrmTask({
        id: proxyTask.id,
        accountId: "acct_mode",
        deliveryMode: "redirect",
      });
      expect(updatedToRedirect?.deliveryMode).toBe("redirect");

      const fetchedRedirect = await repo.getStrmTask(proxyTask.id, "acct_mode");
      expect(fetchedRedirect?.deliveryMode).toBe("redirect");

      // 3. 修改模式为 proxy
      const updatedBackToProxy = await repo.updateStrmTask({
        id: proxyTask.id,
        accountId: "acct_mode",
        deliveryMode: "proxy",
      });
      expect(updatedBackToProxy?.deliveryMode).toBe("proxy");

      const fetchedFinal = await repo.getStrmTask(proxyTask.id, "acct_mode");
      expect(fetchedFinal?.deliveryMode).toBe("proxy");

      // 4. 验证默认值回落为 redirect
      const defaultTask = await repo.createStrmTask({
        accountId: "acct_mode",
        name: "Default Mode Task",
        storageId: "cs_115",
        remoteFolderId: "f_115",
        remotePath: "/115/Movies",
        localOutputDir: "/data/strm/115",
      });
      expect(defaultTask.deliveryMode).toBe("redirect");
    });

    it("handles STRM link caching with TTL and prune", async () => {
      const path = tmpDb();
      const repo = createRepo(path);

      const nowSec = Math.floor(Date.now() / 1000);
      await repo.setStrmLinkCache({
        cacheKey: "115:file_1",
        downloadUrl: "https://cdn.115.com/dl/file_1",
        deliveryMode: "redirect",
        headersJson: JSON.stringify({ "User-Agent": "Plex" }),
        expiresAt: nowSec + 3600, // +1 hour
      });

      await repo.setStrmLinkCache({
        cacheKey: "115:expired_file",
        downloadUrl: "https://cdn.115.com/dl/expired",
        deliveryMode: "redirect",
        headersJson: null,
        expiresAt: nowSec - 10, // expired
      });

      const valid = await repo.getStrmLinkCache("115:file_1");
      expect(valid).not.toBeNull();
      expect(valid?.downloadUrl).toBe("https://cdn.115.com/dl/file_1");

      const expired = await repo.getStrmLinkCache("115:expired_file");
      expect(expired).toBeNull(); // expired link filtered out

      const pruned = await repo.pruneExpiredStrmLinkCache();
      expect(pruned).toBeGreaterThanOrEqual(1);
    });

    it("manages media server configs with encrypted API token", async () => {
      const path = tmpDb();
      const repo = createRepo(path);

      const config = await repo.createMediaServerConfig({
        accountId: "acct_1",
        name: "Home Plex",
        serverType: "plex",
        hostUrl: "http://192.168.1.100:32400/",
        apiToken: "secret_plex_token_xyz",
        pathMappings: [{ id: "m1", localPath: "/data/strm/movies", remotePath: "/movies" }],
      });

      expect(config.hostUrl).toBe("http://192.168.1.100:32400"); // trailing slash stripped
      expect(config.apiTokenEncrypted).not.toBe("secret_plex_token_xyz"); // encrypted

      // Raw db check: verify token is encrypted in DB
      const raw = new Database(path);
      const rawRow = raw.prepare("SELECT * FROM mediaserver_configs WHERE id = ?").get(config.id) as {
        api_token_encrypted: string;
      };
      expect(rawRow.api_token_encrypted).not.toContain("secret_plex_token_xyz");
      raw.close();

      const list = await repo.listMediaServerConfigs("acct_1");
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("Home Plex");
      expect(list[0]?.pathMappings[0]?.remotePath).toBe("/movies");

      const updated = await repo.updateMediaServerConfig({
        id: config.id,
        accountId: "acct_1",
        name: "Updated Home Plex",
        isActive: false,
      });

      expect(updated?.name).toBe("Updated Home Plex");
      expect(updated?.isActive).toBe(false);

      const deleted = await repo.deleteMediaServerConfig(config.id, "acct_1");
      expect(deleted).toBe(true);
      expect(await repo.getMediaServerConfig(config.id, "acct_1")).toBeNull();
    });

    it("creates, updates, and lists STRM and MediaServer execution records in SQLite", async () => {
      const path = tmpDb();
      const repo = createRepo(path);

      const strmRun = await repo.createStrmExecutionRecord({
        taskId: "task_sql_1",
        taskName: "Sqlite STRM Task",
        accountId: "acct_sql",
        triggerSource: "interval",
        status: "running",
        currentProgressPercent: 30,
        currentStepMessage: "正在扫描...",
      });
      expect(strmRun.id).toBeDefined();
      expect(strmRun.status).toBe("running");

      await repo.updateStrmExecutionRecord({
        id: strmRun.id,
        status: "succeeded",
        scannedCount: 100,
        generatedCount: 42,
        currentProgressPercent: 100,
        currentStepMessage: "完成",
        finishedAt: new Date().toISOString(),
        durationMs: 3200,
      });

      const strmHistory = await repo.listStrmExecutionRecords("task_sql_1", "acct_sql", 10);
      expect(strmHistory).toHaveLength(1);
      expect(strmHistory[0]!.status).toBe("succeeded");
      expect(strmHistory[0]!.generatedCount).toBe(42);
      expect(strmHistory[0]!.durationMs).toBe(3200);

      const msRun = await repo.createMediaServerRefreshRecord({
        configId: "cfg_sql_1",
        serverName: "Plex Server",
        serverType: "plex",
        accountId: "acct_sql",
        triggerSource: "manual",
        targetPath: "/media/movies",
        status: "running",
        currentProgressPercent: 50,
      });

      await repo.updateMediaServerRefreshRecord({
        id: msRun.id,
        status: "succeeded",
        sectionsRefreshed: ["Movies", "Anime"],
        refreshedCount: 2,
        currentProgressPercent: 100,
        currentStepMessage: "刷新成功",
        durationMs: 800,
      });

      const msHistory = await repo.listMediaServerRefreshRecords("cfg_sql_1", "acct_sql");
      expect(msHistory).toHaveLength(1);
      expect(msHistory[0]!.status).toBe("succeeded");
      expect(msHistory[0]!.sectionsRefreshed).toEqual(["Movies", "Anime"]);
      expect(msHistory[0]!.refreshedCount).toBe(2);
    });
  });

  describe("InMemoryWorkflowRepository", () => {
    it("implements StrmStore and MediaServerStore in memory", async () => {
      const repo = new InMemoryWorkflowRepository();

      const task = await repo.createStrmTask({
        accountId: "acct_mem",
        name: "Mem Task",
        storageId: "cs_mem",
        remoteFolderId: "f1",
        remotePath: "/Movies",
        localOutputDir: "/strm",
      });

      expect(await repo.listStrmTasks("acct_mem")).toHaveLength(1);

      await repo.updateStrmTask({ id: task.id, accountId: "acct_mem", status: "paused" });
      expect((await repo.getStrmTask(task.id, "acct_mem"))?.status).toBe("paused");

      const ms = await repo.createMediaServerConfig({
        accountId: "acct_mem",
        name: "Mem Emby",
        serverType: "emby",
        hostUrl: "http://localhost:8096",
        apiToken: "emby_token",
      });

      expect(await repo.listMediaServerConfigs("acct_mem")).toHaveLength(1);
      expect((await repo.getMediaServerConfig(ms.id, "acct_mem"))?.name).toBe("Mem Emby");

      // Execution records & progress tracking (InMemory)
      const strmRun = await repo.createStrmExecutionRecord({
        taskId: task.id,
        taskName: task.name,
        accountId: "acct_mem",
        triggerSource: "manual",
        status: "running",
        currentProgressPercent: 15,
        currentStepMessage: "正在扫描网盘目录...",
      });
      expect(strmRun.status).toBe("running");

      await repo.updateStrmExecutionRecord({
        id: strmRun.id,
        status: "succeeded",
        scannedCount: 20,
        generatedCount: 5,
        currentProgressPercent: 100,
        currentStepMessage: "扫描完成",
        durationMs: 1250,
      });

      const latestStrmRun = await repo.getLatestStrmExecutionRecord(task.id, "acct_mem");
      expect(latestStrmRun?.status).toBe("succeeded");
      expect(latestStrmRun?.generatedCount).toBe(5);
      expect(latestStrmRun?.currentProgressPercent).toBe(100);

      const msRun = await repo.createMediaServerRefreshRecord({
        configId: ms.id,
        serverName: ms.name,
        serverType: ms.serverType,
        accountId: "acct_mem",
        triggerSource: "strm_sync",
        targetPath: "/strm/movies/Avatar",
        status: "running",
      });
      expect(msRun.status).toBe("running");

      await repo.updateMediaServerRefreshRecord({
        id: msRun.id,
        status: "succeeded",
        sectionsRefreshed: ["电影"],
        refreshedCount: 1,
        currentProgressPercent: 100,
        durationMs: 450,
      });

      const latestMsRun = await repo.getLatestMediaServerRefreshRecord(ms.id, "acct_mem");
      expect(latestMsRun?.status).toBe("succeeded");
      expect(latestMsRun?.sectionsRefreshed).toEqual(["电影"]);
    });
  });
});
