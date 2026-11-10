import { describe, it, expect, vi } from "vitest";
import { MediaOrganizer } from "../../src/execution/media-organizer.js";
import { StorageArchiveAdapter } from "../../src/storage/storage-archive-adapter.js";
import type { StorageExecutor } from "../../src/domain/ports.js";

describe("MediaOrganizer", () => {
  it("organizes a movie directory by flattening primary and archiving redundant packages", async () => {
    const movedFiles: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
    const removedDirs: string[] = [];

    const mockStorage: Partial<StorageExecutor> = {
      listChildDirectories: vi.fn(async (dirId: string) => {
        if (dirId === "movie_root") {
          return [
            { id: "dir_yts", name: "The Hotel New Hampshire (1984) [1080p] [BluRay YTS.MX]" },
            { id: "dir_rarbg", name: "The.Hotel.New.Hampshire.1984.1080p.BluRay.H264-RARBG" },
            { id: "dir_amiable", name: "The.Hotel.New.Hampshire.1984.1080p.BluRay.X264-AMIABLE" },
          ];
        }
        if (dirId === "archive_root" || dirId === "archive_movies") {
          return [];
        }
        return [];
      }),
      listTree: vi.fn(async () => [
        {
          providerFileId: "f_yts",
          path: "The Hotel New Hampshire (1984) [1080p] [BluRay YTS.MX]/hotel.yts.1080p.mp4",
          sizeBytes: 2_000_000_000,
        },
        {
          providerFileId: "f_rarbg",
          path: "The.Hotel.New.Hampshire.1984.1080p.BluRay.H264-RARBG/hotel.rarbg.1080p.mp4",
          sizeBytes: 8_000_000_000,
        },
        {
          providerFileId: "f_amiable",
          path: "The.Hotel.New.Hampshire.1984.1080p.BluRay.X264-AMIABLE/hotel.amiable.1080p.mkv",
          sizeBytes: 10_000_000_000,
        },
      ]),
      createDirectory: vi.fn(async ({ name }) => `created_${name}`),
      moveFiles: vi.fn(async (input) => {
        movedFiles.push(input);
        return { moved: input.fileIds };
      }),
      removeDirectory: vi.fn(async (id) => {
        removedDirs.push(id);
        return { removed: true };
      }),
      renameFile: vi.fn(async () => {}),
    };

    const archiveAdapter = new StorageArchiveAdapter({
      storage: mockStorage as any,
      rootCid: "archive_root",
    });

    const organizer = new MediaOrganizer({
      storage: mockStorage as StorageExecutor,
      archiveAdapter,
    });

    const result = await organizer.organizeMovieDirectory({
      movieDirectoryId: "movie_root",
      title: "新汉普夏饭店",
      year: 1984,
      tmdbId: 11308,
    });

    expect(result.status).toBe("organized");
    // Primary is amiable (highest score based on 10GB size + mkv + amiable)
    expect(result.primaryMovie?.name).toBe("hotel.amiable.1080p.mkv");

    // Primary was lifted from its wrapper to movie_root
    expect(movedFiles).toContainEqual({
      fileIds: ["f_amiable"],
      targetDirectoryId: "movie_root",
    });

    // The other wrapper directories (yts, rarbg) were archived to archive folder
    expect(result.archivedCount).toBeGreaterThanOrEqual(2);
    expect(result.archivedItems).toContain("The Hotel New Hampshire (1984) [1080p] [BluRay YTS.MX]");
    expect(result.archivedItems).toContain("The.Hotel.New.Hampshire.1984.1080p.BluRay.H264-RARBG");

    // Primary's wrapper dir was cleaned up
    expect(removedDirs).toContain("dir_amiable");
  });

  it("organizes a TV staging directory into Season folders and archives redundant packages", async () => {
    const movedFiles: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
    let stagingRemoved = false;

    const mockStorage: Partial<StorageExecutor> = {
      listChildDirectories: vi.fn(async (dirId: string) => {
        if (dirId === "show_root") {
          return [{ id: "season_01_id", name: "Season 01" }];
        }
        if (dirId === "staging_id") {
          return [
            { id: "dir_pack_24", name: "【高清剧集网】桃源暗鬼[全24集].Tougen.Anki.S01.1080p" },
          ];
        }
        return [];
      }),
      listTree: vi.fn(async (input) => {
        if (input.directoryId === "staging_id") {
          return [
            {
              providerFileId: "f_baha_01",
              path: "[ANI] 桃源暗鬼 - 01 [1080P][Baha][WEB-DL].mp4",
              sizeBytes: 1_200_000_000,
            },
            {
              providerFileId: "f_baha_02",
              path: "[ANI] 桃源暗鬼 - 02 [1080P][Baha][WEB-DL].mp4",
              sizeBytes: 1_200_000_000,
            },
            {
              providerFileId: "f_pack_01",
              path: "【高清剧集网】桃源暗鬼[全24集].Tougen.Anki.S01.1080p/Tougen.Anki.S01E01.mp4",
              sizeBytes: 800_000_000,
            },
            {
              providerFileId: "f_pack_02",
              path: "【高清剧集网】桃源暗鬼[全24集].Tougen.Anki.S01.1080p/Tougen.Anki.S01E02.mp4",
              sizeBytes: 800_000_000,
            },
          ];
        }
        return [];
      }),
      createDirectory: vi.fn(async ({ name }) => `created_${name}`),
      moveFiles: vi.fn(async (input) => {
        movedFiles.push(input);
        return { moved: input.fileIds };
      }),
      removeDirectory: vi.fn(async (id) => {
        if (id === "staging_id") stagingRemoved = true;
        return { removed: true };
      }),
      renameFile: vi.fn(async () => {}),
    };

    const archiveAdapter = new StorageArchiveAdapter({
      storage: mockStorage as any,
      rootCid: "archive_root",
    });

    const organizer = new MediaOrganizer({
      storage: mockStorage as StorageExecutor,
      archiveAdapter,
    });

    const result = await organizer.organizeStagingDirectory({
      stagingDirectoryId: "staging_id",
      showDirectoryId: "show_root",
      title: "桃源暗鬼",
      type: "anime",
      year: 2025,
      tmdbId: 253811,
    });

    expect(result.status).toBe("organized");
    expect(result.placedEpisodes).toContain("S01E01");
    expect(result.placedEpisodes).toContain("S01E02");

    // Highest quality (Baha 1.2GB) was moved to Season 01
    expect(movedFiles).toContainEqual({
      fileIds: ["f_baha_01"],
      targetDirectoryId: "season_01_id",
    });
    expect(movedFiles).toContainEqual({
      fileIds: ["f_baha_02"],
      targetDirectoryId: "season_01_id",
    });

    // Redundant pack was archived
    expect(result.archivedCount).toBeGreaterThanOrEqual(1);

    // Staging was removed
    expect(stagingRemoved).toBe(true);
  });
});
