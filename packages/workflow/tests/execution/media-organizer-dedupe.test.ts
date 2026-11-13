import { describe, expect, it, vi } from "vitest";
import { MediaOrganizer } from "../../src/execution/media-organizer.js";
import { StorageArchiveAdapter } from "../../src/storage/storage-archive-adapter.js";
import type { StorageExecutor } from "../../src/domain/ports.js";

function makeStorage(input: {
  children: Record<string, Array<{ id: string; name: string }>>;
  trees: Record<string, Array<{ providerFileId: string; path: string; sizeBytes: number }>>;
  moved?: Array<{ fileIds: string[]; targetDirectoryId: string }>;
  removed?: string[];
}): Partial<StorageExecutor> {
  return {
    listChildDirectories: vi.fn(async (dirId: string) => input.children[dirId] ?? []),
    listTree: vi.fn(async ({ directoryId }: { directoryId: string }) => input.trees[directoryId] ?? []),
    createDirectory: vi.fn(async ({ name }: { name: string }) => `created_${name}`),
    moveFiles: vi.fn(async (payload) => {
      input.moved?.push(payload);
      return { moved: payload.fileIds };
    }),
    removeDirectory: vi.fn(async (id: string) => {
      input.removed?.push(id);
      return { removed: true };
    }),
    renameFile: vi.fn(async () => {}),
  };
}

describe("MediaOrganizer.dedupeSeasonDirectories", () => {
  it("同一集存在多个版本时，只保留一个，其余归档", async () => {
    const moved: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
    const storage = makeStorage({
      children: {
        show: [{ id: "season_01", name: "Season 01" }],
        archive_root: [],
        archive_anime: [],
        archive_title: [],
      },
      trees: {
        season_01: [
          { providerFileId: "f1", path: "凡人修仙传 - S01E01.mp4", sizeBytes: 500 * 1024 * 1024 },
          { providerFileId: "f2", path: "凡人修仙传 - S01E01(1).mp4", sizeBytes: 1_600 * 1024 * 1024 },
          { providerFileId: "f3", path: "凡人修仙传 - S01E01(2).mp4", sizeBytes: 1_300 * 1024 * 1024 },
          { providerFileId: "f4", path: "凡人修仙传 - S01E02.mp4", sizeBytes: 400 * 1024 * 1024 },
        ],
      },
      moved,
    });
    const organizer = new MediaOrganizer({
      storage: storage as StorageExecutor,
      archiveAdapter: new StorageArchiveAdapter({ storage: storage as any, rootCid: "archive_root" }),
    });

    const result = await organizer.dedupeSeasonDirectories({
      showDirectoryId: "show",
      title: "凡人修仙传",
      type: "anime",
      year: 2020,
      tmdbId: 106449,
    });

    expect(result.seasonsScanned).toBe(1);
    // 同集 3 个版本 → 归档 2 个；E02 只有 1 个 → 不动
    expect(result.archivedCount).toBe(2);
    const archivedIds = moved.flatMap((m) => m.fileIds).sort();
    expect(archivedIds).toEqual(["f1", "f3"].sort());
  });

  it("没有重复时不产生任何移动", async () => {
    const moved: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
    const storage = makeStorage({
      children: { show: [{ id: "season_01", name: "Season 01" }] },
      trees: { season_01: [{ providerFileId: "f1", path: "凡人修仙传 - S01E01.mp4", sizeBytes: 900 * 1024 * 1024 }] },
      moved,
    });
    const organizer = new MediaOrganizer({
      storage: storage as StorageExecutor,
      archiveAdapter: new StorageArchiveAdapter({ storage: storage as any, rootCid: "archive_root" }),
    });

    const result = await organizer.dedupeSeasonDirectories({
      showDirectoryId: "show",
      title: "凡人修仙传",
      type: "anime",
      year: 2020,
      tmdbId: 106449,
    });

    expect(result.archivedCount).toBe(0);
    expect(moved).toHaveLength(0);
  });
});

describe("MediaOrganizer.cleanupStagingDirectories", () => {
  it("**含无扩展名大文件时绝不删除**（转存丢后缀的真实正片）", async () => {
    const removed: string[] = [];
    const storage = makeStorage({
      children: { show: [{ id: "st_noext", name: "staging-noext" }] },
      trees: {
        st_noext: [
          {
            providerFileId: "big1",
            path: "【高清剧集网】凡人修仙传[第175集][国语配音].A.Mortals.Journey.S01.1080p.WEB-DL.H264",
            sizeBytes: 1_200 * 1024 * 1024,
          },
        ],
      },
      removed,
    });
    const organizer = new MediaOrganizer({
      storage: storage as StorageExecutor,
      archiveAdapter: new StorageArchiveAdapter({ storage: storage as any, rootCid: "archive_root" }),
    });

    const result = await organizer.cleanupStagingDirectories({ showDirectoryId: "show" });

    expect(result.removed).toEqual([]);
    expect(result.remaining).toEqual(["staging-noext"]);
    expect(removed).toEqual([]);
  });

  it("删除空的 staging 目录，保留仍有视频的", async () => {
    const removed: string[] = [];
    const storage = makeStorage({
      children: {
        show: [
          { id: "st_empty", name: "staging-aaa" },
          { id: "st_with_video", name: "staging-bbb" },
          { id: "season_01", name: "Season 01" },
        ],
      },
      trees: {
        st_empty: [{ providerFileId: "n1", path: "readme.txt", sizeBytes: 10 }],
        st_with_video: [{ providerFileId: "v1", path: "EP01.mp4", sizeBytes: 900 * 1024 * 1024 }],
      },
      removed,
    });
    const organizer = new MediaOrganizer({
      storage: storage as StorageExecutor,
      archiveAdapter: new StorageArchiveAdapter({ storage: storage as any, rootCid: "archive_root" }),
    });

    const result = await organizer.cleanupStagingDirectories({ showDirectoryId: "show" });

    expect(result.removed).toEqual(["staging-aaa"]);
    expect(result.remaining).toEqual(["staging-bbb"]);
    expect(removed).toEqual(["st_empty"]);
  });
});
