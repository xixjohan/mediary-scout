import { describe, it, expect, vi } from "vitest";
import { Pan115UnifiedStorageApi } from "../../src/storage/pan115-unified-api.js";
import type { Pan115StorageApi } from "../../src/storage/storage-115-executor.js";
import type { Pan115OpenClient } from "../../src/storage/pan115-open-client.js";

describe("Pan115UnifiedStorageApi (Dual-Engine Hybrid Adapter)", () => {
  it("strictly routes receiveShare to Cookie API because 115 Open API lacks share transfer", async () => {
    const mockCookieReceive = vi.fn(async () => ({ ok: true, message: "" }));
    const mockCookieApi: Partial<Pan115StorageApi> = {
      receiveShare: mockCookieReceive,
    };

    const mockOpenClient: Partial<Pan115OpenClient> = {};

    const unifiedApi = new Pan115UnifiedStorageApi({
      cookieApi: mockCookieApi as Pan115StorageApi,
      openApi: mockOpenClient as Pan115OpenClient,
      mode: "dual_engine",
    });

    const res = await unifiedApi.receiveShare({
      shareCode: "s_abc",
      receiveCode: "1234",
      directoryId: "cid_target",
    });

    expect(res.ok).toBe(true);
    expect(mockCookieReceive).toHaveBeenCalledTimes(1);
    expect(mockCookieReceive).toHaveBeenCalledWith({
      shareCode: "s_abc",
      receiveCode: "1234",
      directoryId: "cid_target",
    });
  });

  it("throws informative guidance error when receiveShare is called without Cookie credentials", async () => {
    const mockOpenClient: Partial<Pan115OpenClient> = {};

    const openOnlyApi = new Pan115UnifiedStorageApi({
      openApi: mockOpenClient as Pan115OpenClient,
      mode: "open_only",
    });

    await expect(
      openOnlyApi.receiveShare({
        shareCode: "s_abc",
        receiveCode: "1234",
        directoryId: "cid_target",
      }),
    ).rejects.toThrowError(/115 开放平台.*暂未开放分享转存接口/);
  });

  it("prioritizes Open API for large directory listing and falls back to Cookie API when Open API fails", async () => {
    let fallbackReported = false;
    const mockCookieList = vi.fn(async () => [
      { id: "f_cookie", name: "cookie_item.mkv", isDirectory: false },
    ]);
    const mockCookieApi: Partial<Pan115StorageApi> = {
      listItems: mockCookieList,
    };

    // 1. 正常优先走 Open API
    const mockOpenListSuccess = vi.fn(async () => [
      { id: "f_open", name: "open_item.mkv", isDirectory: false },
    ]);
    const normalUnifiedApi = new Pan115UnifiedStorageApi({
      cookieApi: mockCookieApi as Pan115StorageApi,
      openApi: { listItems: mockOpenListSuccess } as unknown as Pan115OpenClient,
      mode: "dual_engine",
    });

    const successResult = await normalUnifiedApi.listItems({ directoryId: "cid_1" });
    expect(successResult).toHaveLength(1);
    expect(successResult[0]!.name).toBe("open_item.mkv");
    expect(mockOpenListSuccess).toHaveBeenCalledTimes(1);
    expect(mockCookieList).not.toHaveBeenCalled();

    // 2. Open API 发生异常时，自动平滑降级至 Cookie API
    const mockOpenListFailing = vi.fn(async () => {
      throw new Error("Open API temporary network glitch");
    });
    const resilientUnifiedApi = new Pan115UnifiedStorageApi({
      cookieApi: mockCookieApi as Pan115StorageApi,
      openApi: { listItems: mockOpenListFailing } as unknown as Pan115OpenClient,
      mode: "dual_engine",
      onFallback: (op) => {
        if (op === "listItems") fallbackReported = true;
      },
    });

    const fallbackResult = await resilientUnifiedApi.listItems({ directoryId: "cid_1" });
    expect(fallbackResult).toHaveLength(1);
    expect(fallbackResult[0]!.name).toBe("cookie_item.mkv");
    expect(mockCookieList).toHaveBeenCalledTimes(1);
    expect(fallbackReported).toBe(true);
  });

  it("prioritizes Open API for file write/move/delete operations with Cookie fallback", async () => {
    const mockOpenCreateFolder = vi.fn(async () => "cid_open_created");
    const mockCookieCreateFolder = vi.fn(async () => "cid_cookie_created");

    const unifiedApi = new Pan115UnifiedStorageApi({
      cookieApi: { createFolder: mockCookieCreateFolder } as unknown as Pan115StorageApi,
      openApi: { createFolder: mockOpenCreateFolder } as unknown as Pan115OpenClient,
      mode: "dual_engine",
    });

    const folderId = await unifiedApi.createFolder({ name: "New Folder", parentId: "0" });
    expect(folderId).toBe("cid_open_created");
    expect(mockOpenCreateFolder).toHaveBeenCalledTimes(1);
    expect(mockCookieCreateFolder).not.toHaveBeenCalled();
  });
  it("reconstructs directory ancestry in Open-Only mode using dynamically tracked parent hierarchy", async () => {
    const mockOpenCreate = vi.fn(async ({ name, parentId }) => {
      if (name === "TV_Root") return "cid_tv";
      if (name === "Breaking Bad") return "cid_show";
      if (name === "Season 01") return "cid_s1";
      return "cid_generic";
    });

    const openOnlyApi = new Pan115UnifiedStorageApi({
      openApi: { createFolder: mockOpenCreate } as unknown as Pan115OpenClient,
      mode: "open_only",
    });

    const tvCid = await openOnlyApi.createFolder({ name: "TV_Root", parentId: "0" });
    const showCid = await openOnlyApi.createFolder({ name: "Breaking Bad", parentId: tvCid });
    const s1Cid = await openOnlyApi.createFolder({ name: "Season 01", parentId: showCid });

    const dirInfo = await openOnlyApi.getDirectoryInfo({ directoryId: s1Cid });
    expect(dirInfo).not.toBeNull();
    expect(dirInfo?.state).toBe(true);

    const pathCids = dirInfo?.path.map((p) => p.cid);
    expect(pathCids).toEqual(["0", "cid_tv", "cid_show", "cid_s1"]);
  });
});
