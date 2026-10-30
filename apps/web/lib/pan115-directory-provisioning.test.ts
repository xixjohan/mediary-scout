import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakePan115QrLoginClient {
  async exchangeCookie() {
    return { cookie: "UID=3204551_A1_1; CID=fresh; SEID=fresh", userName: "testuser", app: "tv" };
  }
}

class FakePan115StorageApi {
  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    return `cid_${input.name.toLowerCase()}`;
  }
  async listItems(_input: { directoryId: string }): Promise<Array<{ id: string; name: string; isDirectory: boolean }>> {
    return [];
  }
  async getDirectoryInfo(input: { directoryId: string }) {
    return { id: input.directoryId, name: "root", path: [] };
  }
}

class FakePan115StorageExecutor {
  async listChildDirectories(_parentId: string): Promise<Array<{ name: string; id: string }>> {
    return [];
  }
  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    return `cid_${input.name.toLowerCase()}`;
  }
}

const prevSqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevAdapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER;

const COLD_IMPORT_TIMEOUT_MS = 30_000;
let rt: typeof import("./workflow-runtime");

beforeEach(async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_STORAGE_ADAPTER; // Simulate standard Docker container without adapter env
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return {
      ...actual,
      Pan115QrLoginClient: FakePan115QrLoginClient,
      Pan115CookieClient: class extends FakePan115StorageApi {},
      createBootstrapPan115CookieStorageExecutor: () => new FakePan115StorageExecutor(),
    };
  });
  rt = await import("./workflow-runtime");
}, COLD_IMPORT_TIMEOUT_MS);

afterEach(() => {
  vi.doUnmock("@media-track/workflow");
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevSqlitePath !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlitePath;
  if (prevAdapter !== undefined) process.env.MEDIA_TRACK_STORAGE_ADAPTER = prevAdapter;
  else delete process.env.MEDIA_TRACK_STORAGE_ADAPTER;
  vi.resetModules();
});

describe("115 网盘目录待建与原地自愈治理 (Pan115 directory provisioning & self-healing)", () => {
  it("测试连接时检测到缺少分类目录，原地自愈补建并持久化 CIDs", async () => {
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_3204551",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "3204551",
      label: "115_3204551",
      payload: { cookie: "UID=3204551_A1_1; CID=old; SEID=old" },
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2026-10-30T00:00:00.000Z",
    });

    const result = await rt.testConnection("acct_default", "cs_3204551");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("目录已初始化就绪");

    const storages = await repository.listConnectedStorages("acct_default");
    const drive = storages.find((s) => s.id === "cs_3204551");
    expect(drive).toBeDefined();
    expect(drive?.rootCid).toBe("cid_mediary scout");
    expect(drive?.moviesCid).toBe("cid_movies");
    expect(drive?.tvCid).toBe("cid_tv");
    expect(drive?.animeCid).toBe("cid_anime");
  });

  it("已就绪的网盘执行测试连接，不重复触发补建", async () => {
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_ready_115",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "3204551",
      label: "ready",
      payload: { cookie: "UID=3204551_A1_1; CID=old; SEID=old" },
      rootCid: "root_ok",
      moviesCid: "movies_ok",
      tvCid: "tv_ok",
      animeCid: "anime_ok",
      createdAt: "2026-10-30T00:00:00.000Z",
    });

    const result = await rt.testConnection("acct_default", "cs_ready_115");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("连接正常。");
  });

  it("无 MEDIA_TRACK_STORAGE_ADAPTER 环境变量时，全新绑定 115 网盘自动建树", async () => {
    delete process.env.MEDIA_TRACK_STORAGE_ADAPTER;
    await rt.completePan115QrLogin({
      session: { uid: "u", time: 1, sign: "s", qrcodeContent: "q" },
    });

    const repository = rt.getWorkflowRepository();
    const storages = await repository.listConnectedStorages("acct_default");
    const drive = storages.find((s) => s.providerUid === "3204551");
    expect(drive).toBeDefined();
    expect(drive?.rootCid).toBe("cid_mediary scout");
    expect(drive?.moviesCid).toBe("cid_movies");
    expect(drive?.tvCid).toBe("cid_tv");
    expect(drive?.animeCid).toBe("cid_anime");
  });

  it("重新扫码已存在但缺少 CIDs 的 115 网盘，自动补全分类目录", async () => {
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_3204551",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "3204551",
      label: "old_label",
      payload: { cookie: "UID=3204551_A1_1; CID=old; SEID=old" },
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2026-10-30T00:00:00.000Z",
    });

    await rt.completePan115QrLogin({
      session: { uid: "u", time: 1, sign: "s", qrcodeContent: "q" },
    });

    const storages = await repository.listConnectedStorages("acct_default");
    const drive = storages.find((s) => s.id === "cs_3204551");
    expect(drive?.rootCid).toBe("cid_mediary scout");
    expect(drive?.moviesCid).toBe("cid_movies");
    expect(drive?.tvCid).toBe("cid_tv");
    expect(drive?.animeCid).toBe("cid_anime");
  });
});
