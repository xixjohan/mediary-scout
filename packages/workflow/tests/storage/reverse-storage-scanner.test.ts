import { describe, expect, it, vi } from "vitest";
import { runReverseStorageScan } from "../../src/storage/reverse-storage-scanner.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import type { DriveFileManager, DriveDirectoryListing, DriveFileItem } from "../../src/storage/drive-file-manager.js";

function makeItem(item: { id: string; name: string; isFolder: boolean; sizeBytes?: number }): DriveFileItem {
  return {
    id: item.id,
    name: item.name,
    isFolder: item.isFolder,
    sizeBytes: item.sizeBytes ?? 0,
    updatedAt: "2026-01-01T00:00:00Z",
    type: item.isFolder ? "folder" : "video",
    extension: item.name.split(".").pop() ?? "",
  };
}

class MockDriveFileManager implements DriveFileManager {
  private readonly dirs = new Map<string, DriveDirectoryListing>();

  setDirectory(id: string, listing: { items?: Array<{ id: string; name: string; isFolder: boolean; sizeBytes?: number }> }) {
    const items = (listing.items ?? []).map(makeItem);
    this.dirs.set(id, {
      storageId: "mock",
      provider: "pan115",
      currentDirectoryId: id,
      currentDirectoryName: id,
      items,
      totalCount: items.length,
      folderCount: items.filter((i) => i.isFolder).length,
      fileCount: items.filter((i) => !i.isFolder).length,
      totalSizeBytes: items.reduce((sum, i) => sum + i.sizeBytes, 0),
      breadcrumbs: [],
      rootCid: "0",
      moviesCid: "movies_root",
      tvCid: "tv_root",
      animeCid: "anime_root",
    });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const id = directoryId ?? "0";
    return (
      this.dirs.get(id) ?? {
        storageId: "mock",
        provider: "pan115",
        currentDirectoryId: id,
        currentDirectoryName: id,
        items: [],
        totalCount: 0,
        folderCount: 0,
        fileCount: 0,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: "0",
        moviesCid: "movies_root",
        tvCid: "tv_root",
        animeCid: "anime_root",
      }
    );
  }

  async createFolder(): Promise<{ id: string; name: string }> { throw new Error("not implemented"); }
  async renameItem(): Promise<void> {}
  async deleteItems(): Promise<{ deletedCount: number }> { return { deletedCount: 0 }; }
  async moveItems(): Promise<{ movedCount: number }> { return { movedCount: 0 }; }
  async copyItems(): Promise<{ copiedCount: number }> { return { copiedCount: 0 }; }
}

describe("runReverseStorageScan", () => {
  it("walks directories, discovers canonical media folders, and auto-adopts high-confidence items", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("target_root", {
      items: [
        { id: "dir_sub1", name: "精选合集", isFolder: true, sizeBytes: 0 },
        { id: "dir_movie1", name: "星际穿越 (2014) {tmdb-157336}", isFolder: true, sizeBytes: 0 },
      ],
    });

    mock.setDirectory("dir_sub1", {
      items: [
        { id: "dir_movie2", name: "寄生虫 (2019) {tmdb-496243}", isFolder: true, sizeBytes: 0 },
      ],
    });

    mock.setDirectory("dir_movie1", {
      items: [
        { id: "f1", name: "Interstellar.2014.2160p.mp4", isFolder: false, sizeBytes: 15 * 1024 * 1024 * 1024 },
      ],
    });

    mock.setDirectory("dir_movie2", {
      items: [
        { id: "f2", name: "Parasite.2019.1080p.mkv", isFolder: false, sizeBytes: 8 * 1024 * 1024 * 1024 },
      ],
    });

    const repo = new InMemoryWorkflowRepository();
    const job = await repo.createReverseScanJob({
      accountId: "acct_test",
      storageId: "cs_1",
      targetCid: "target_root",
    });

    await runReverseStorageScan({
      fileManager: mock,
      storageProvider: "quark",
      jobId: job.id,
      accountId: "acct_test",
      storageId: "cs_1",
      targetCid: "target_root",
      repo,
      pacerDelayMs: 0, // 0 for instant test execution
    });

    const finishedJob = await repo.getReverseScanJob(job.id);
    expect(finishedJob?.status).toBe("completed");
    expect(finishedJob?.discoveredTitles).toBe(2);
    expect(finishedJob?.autoIngestedTitles).toBe(2);
    expect(finishedJob?.progressPercent).toBe(100);

    const items = await repo.listReverseScanItems(job.id);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.reviewStatus === "auto_accepted")).toBe(true);

    const tracked = await repo.listTrackedSeasonStates({ accountId: "acct_test", connectedStorageId: "cs_1" });
    expect(tracked).toHaveLength(2);
  });

  it("accurately discovers TV show with Season XX subfolders and marks episodes obtained without collapsing to 1 episode", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("target_root", {
      items: [
        { id: "dir_tv_show", name: "桃源暗鬼 (2025) {tmdb-253811}", isFolder: true, sizeBytes: 0 },
      ],
    });

    mock.setDirectory("dir_tv_show", {
      items: [
        { id: "dir_season_1", name: "Season 01", isFolder: true, sizeBytes: 0 },
      ],
    });

    // 12 episodes in Season 01
    const season1Files = Array.from({ length: 12 }, (_, i) => {
      const epNum = i + 1;
      const pad = String(epNum).padStart(2, "0");
      return {
        id: `f_s01e${pad}`,
        name: `桃源暗鬼 - S01E${pad} [Ani] [1080P].mp4`,
        isFolder: false,
        sizeBytes: 800 * 1024 * 1024,
      };
    });
    mock.setDirectory("dir_season_1", { items: season1Files });

    const repo = new InMemoryWorkflowRepository();
    const job = await repo.createReverseScanJob({
      accountId: "acct_test",
      storageId: "cs_1",
      targetCid: "target_root",
      category: "tv",
    });

    // Mock searchProvider that returns 12 episodes for Season 1
    const searchProvider = {
      searchMedia: vi.fn().mockResolvedValue([
        {
          tmdbId: 253811,
          mediaType: "tv",
          title: "桃源暗鬼",
          originalTitle: "桃源暗鬼",
          year: 2025,
          overview: "新世代暗黑英雄传奇",
          posterPath: "/poster.jpg",
          backdropPath: null,
          seasons: [
            { seasonNumber: 1, episodeCount: 12, latestAiredEpisode: 12 },
          ],
        },
      ]),
    };

    await runReverseStorageScan({
      fileManager: mock,
      storageProvider: "pan115",
      jobId: job.id,
      accountId: "acct_test",
      storageId: "cs_1",
      targetCid: "target_root",
      repo,
      searchProvider: searchProvider as any,
      pacerDelayMs: 0,
    });

    const finishedJob = await repo.getReverseScanJob(job.id);
    expect(finishedJob?.status).toBe("completed");
    expect(finishedJob?.discoveredTitles).toBe(1);
    expect(finishedJob?.autoIngestedTitles).toBe(1);

    const tracked = await repo.listTrackedSeasonStates({ accountId: "acct_test", connectedStorageId: "cs_1" });
    expect(tracked).toHaveLength(1);

    const s1 = tracked[0]!;
    expect(s1.title.tmdbId).toBe(253811);
    expect(s1.season.seasonNumber).toBe(1);
    // 关键断言：总集数必须是权威 12 集，绝不能缩水为 1 集！
    expect(s1.season.totalEpisodes).toBe(12);
    // 目录必须正确绑定到 Season 01 目录 ID，而非父目录
    expect(s1.season.storageDirectoryId).toBe("dir_season_1");
    // 全部 12 集正片都必须被标记为已获取 (obtained: true)
    expect(s1.episodes.filter((e) => e.obtained)).toHaveLength(12);
    expect(s1.season.status).toBe("completed");
  });
});
