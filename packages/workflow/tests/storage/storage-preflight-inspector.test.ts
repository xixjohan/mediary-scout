import { describe, expect, it } from "vitest";
import {
  findExistingMediaFolder,
  inspectStorageBeforeAcquisition,
} from "../../src/storage/storage-preflight-inspector.js";
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

  setDirectory(id: string, listing: { items?: Array<{ id: string; name: string; isFolder: boolean; sizeBytes?: number; updatedAt?: string }> }) {
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

  async createFolder(): Promise<{ id: string; name: string }> {
    throw new Error("not implemented");
  }
  async renameItem(): Promise<void> {}
  async deleteItems(): Promise<{ deletedCount: number }> {
    return { deletedCount: 0 };
  }
  async moveItems(): Promise<{ movedCount: number }> {
    return { movedCount: 0 };
  }
  async copyItems(): Promise<{ copiedCount: number }> {
    return { copiedCount: 0 };
  }
}

describe("StoragePreflightInspector", () => {
  it("findExistingMediaFolder matches canonical {tmdb-N} folder name", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("movies_root", {
      items: [
        { id: "f1", name: "奥本海默 (2023) {tmdb-872585}", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
        { id: "f2", name: "流浪地球 2 (2023)", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });

    const folder = await findExistingMediaFolder(mock, "movies_root", {
      title: "奥本海默",
      year: 2023,
      tmdbId: 872585,
    });
    expect(folder).not.toBeNull();
    expect(folder?.id).toBe("f1");
  });

  it("findExistingMediaFolder matches legacy Title (Year) folder name", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("movies_root", {
      items: [
        { id: "f2", name: "肖申克的救赎 (1994)", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });

    const folder = await findExistingMediaFolder(mock, "movies_root", {
      title: "肖申克的救赎",
      year: 1994,
      tmdbId: 278,
    });
    expect(folder).not.toBeNull();
    expect(folder?.id).toBe("f2");
  });

  it("inspectStorageBeforeAcquisition detects existing movie with full completeness", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("movies_root", {
      items: [
        { id: "f1", name: "奥本海默 (2023) {tmdb-872585}", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });
    mock.setDirectory("f1", {
      items: [
        { id: "v1", name: "Oppenheimer.2023.2160p.mp4", isFolder: false, sizeBytes: 15 * 1024 * 1024 * 1024, updatedAt: "2026-01-01" },
      ],
    });

    const res = await inspectStorageBeforeAcquisition({
      storage: mock,
      mediaKind: "movie",
      title: "奥本海默",
      year: 2023,
      tmdbId: 872585,
      categoryParentId: "movies_root",
    });

    expect(res.mediaKind).toBe("movie");
    if (res.mediaKind === "movie") {
      expect(res.matched).toBe(true);
      expect(res.completeness).toBe("full");
      expect(res.videoFiles).toHaveLength(1);
      expect(res.videoFiles[0]?.id).toBe("v1");
    }
  });

  it("inspectStorageBeforeAcquisition detects missing movie folder", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("movies_root", { items: [] });

    const res = await inspectStorageBeforeAcquisition({
      storage: mock,
      mediaKind: "movie",
      title: "未知电影",
      year: 2026,
      tmdbId: 999999,
      categoryParentId: "movies_root",
    });

    expect(res.mediaKind).toBe("movie");
    if (res.mediaKind === "movie") {
      expect(res.matched).toBe(false);
      expect(res.completeness).toBe("none");
    }
  });

  it("inspectStorageBeforeAcquisition detects TV series with full completeness", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("tv_root", {
      items: [
        { id: "show_1", name: "三体 (2023) {tmdb-202345}", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });
    mock.setDirectory("show_1", {
      items: [
        { id: "s1_dir", name: "Season 01", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });
    mock.setDirectory("s1_dir", {
      items: [
        { id: "ep1", name: "Three.Body.S01E01.mp4", isFolder: false, sizeBytes: 1024, updatedAt: "2026-01-01" },
        { id: "ep2", name: "Three.Body.S01E02.mp4", isFolder: false, sizeBytes: 1024, updatedAt: "2026-01-01" },
      ],
    });

    const res = await inspectStorageBeforeAcquisition({
      storage: mock,
      mediaKind: "tv",
      title: "三体",
      year: 2023,
      tmdbId: 202345,
      categoryParentId: "tv_root",
      seasons: [
        { seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 },
      ],
    });

    expect(res.matched).toBe(true);
    if (res.mediaKind === "tv") {
      expect(res.overallCompleteness).toBe("full");
      expect(res.seasons).toHaveLength(1);
      expect(res.seasons[0]?.completeness).toBe("full");
      expect(res.seasons[0]?.existingEpisodes).toHaveLength(2);
      expect(res.seasons[0]?.missingEpisodeNumbers).toHaveLength(0);
    }
  });

  it("inspectStorageBeforeAcquisition detects TV series with partial completeness and returns missing episode numbers", async () => {
    const mock = new MockDriveFileManager();
    mock.setDirectory("tv_root", {
      items: [
        { id: "show_1", name: "狂飙 (2023)", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });
    mock.setDirectory("show_1", {
      items: [
        { id: "s1_dir", name: "Season 1", isFolder: true, sizeBytes: 0, updatedAt: "2026-01-01" },
      ],
    });
    // 只有第 1 集，但已播出 3 集
    mock.setDirectory("s1_dir", {
      items: [
        { id: "ep1", name: "狂飙.S01E01.4k.mp4", isFolder: false, sizeBytes: 1024, updatedAt: "2026-01-01" },
      ],
    });

    const res = await inspectStorageBeforeAcquisition({
      storage: mock,
      mediaKind: "tv",
      title: "狂飙",
      year: 2023,
      tmdbId: 154887,
      categoryParentId: "tv_root",
      seasons: [
        { seasonNumber: 1, totalEpisodes: 39, latestAiredEpisode: 3 },
      ],
    });

    expect(res.matched).toBe(true);
    if (res.mediaKind === "tv") {
      expect(res.overallCompleteness).toBe("partial");
      expect(res.seasons[0]?.completeness).toBe("partial");
      expect(res.seasons[0]?.existingEpisodes).toHaveLength(1);
      expect(res.seasons[0]?.missingEpisodeNumbers).toEqual([2, 3]);
    }
  });
});
