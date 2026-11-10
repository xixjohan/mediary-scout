import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as adoptFolder } from "./route";

const fakeManager = {
  listDirectory: vi.fn(),
};

const mockRepo = {
  saveWorkflowRunSnapshot: vi.fn(async () => {}),
};

vi.mock("../../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(async () => "acct_test"),
}));

vi.mock("../../../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: vi.fn(async () => fakeManager),
}));

vi.mock("../../../../../composition/runtime-container", () => ({
  getWorkflowRepository: vi.fn(() => mockRepo),
}));

vi.mock("../../../../../features/settings-system/application/system-settings-service", () => ({
  getAccountScopedSettings: vi.fn(() => ({})),
}));

vi.mock("../../../../../lib/runtime/settings-readers", () => ({
  getTmdbAccesses: vi.fn(async () => []),
}));

vi.mock("../../../../../lib/series-target", () => ({
  seriesTargetFor: vi.fn(async (tmdbId: number) => {
    if (tmdbId === 253811) {
      return {
        title: {
          id: "tmdb_tv_253811",
          tmdbId: 253811,
          type: "tv",
          title: "桃源暗鬼",
          originalTitle: "桃源暗鬼",
          year: 2025,
          aliases: [],
          posterPath: "/poster.jpg",
          backdropPath: null,
        },
        seasons: [
          { seasonNumber: 1, totalEpisodes: 24, latestAiredEpisode: 12 },
          { seasonNumber: 2, totalEpisodes: 24, latestAiredEpisode: 6 },
        ],
      };
    }
    return null;
  }),
}));

describe("POST /api/storage/files/adopt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when folderId or folderName is missing", async () => {
    const req = new NextRequest("http://localhost/api/storage/files/adopt", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await adoptFolder(req);
    expect(res.status).toBe(400);
  });

  it("successfully adopts recognized movie folder", async () => {
    fakeManager.listDirectory.mockResolvedValue({
      items: [
        { id: "v1", name: "Inception.2010.mp4", isFolder: false, sizeBytes: 1024 * 1024 * 1000, type: "video" },
      ],
    });

    const req = new NextRequest("http://localhost/api/storage/files/adopt", {
      method: "POST",
      body: JSON.stringify({
        storageId: "cs_1",
        folderId: "dir_inception",
        folderName: "盗梦空间 (2010) {tmdb-1001}",
      }),
    });

    const res = await adoptFolder(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toContain("盗梦空间");
    expect(mockRepo.saveWorkflowRunSnapshot).toHaveBeenCalled();
  });

  it("successfully adopts season folder when parent series info is provided", async () => {
    fakeManager.listDirectory.mockResolvedValue({
      items: [
        { id: "v1", name: "桃源暗鬼 - S01E01.mp4", isFolder: false, sizeBytes: 800 * 1024 * 1024, type: "video" },
        { id: "v2", name: "桃源暗鬼 - S01E02.mp4", isFolder: false, sizeBytes: 800 * 1024 * 1024, type: "video" },
      ],
    });

    const req = new NextRequest("http://localhost/api/storage/files/adopt", {
      method: "POST",
      body: JSON.stringify({
        storageId: "cs_1",
        folderId: "dir_season_1",
        folderName: "Season 01",
        parentFolderName: "桃源暗鬼 (2025) {tmdb-253811}",
        tmdbId: 253811,
        seasonNumber: 1,
      }),
    });

    const res = await adoptFolder(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toContain("桃源暗鬼");
    expect(data.message).toContain("第 1 季");
  });
});
