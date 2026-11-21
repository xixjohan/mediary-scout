import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  executeScanDriveMedia,
  executeAdoptDriveMedia,
  executePlanOrganizeMedia,
  executeExecuteOrganizeMedia,
} from "./drive-media-executor";

// Mock dependencies
const mockListDirectory = vi.fn();
const mockListTrackedSeasonStates = vi.fn();
const mockSaveWorkflowRunSnapshot = vi.fn();
const mockAdoptExistingMovie = vi.fn();
const mockAdoptExistingTvSeason = vi.fn();
const mockHandleMovieOrganize = vi.fn();
const mockHandleTvOrganize = vi.fn();
const mockSeriesTargetFor = vi.fn();

vi.mock("@media-track/workflow", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    adoptExistingMovie: (...args: unknown[]) => mockAdoptExistingMovie(...args),
    adoptExistingTvSeason: (...args: unknown[]) => mockAdoptExistingTvSeason(...args),
  };
});

vi.mock("../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: vi.fn().mockImplementation(() =>
    Promise.resolve({
      listDirectory: mockListDirectory,
    }),
  ),
  getWorkflowRepository: vi.fn().mockImplementation(() => ({
    listTrackedSeasonStates: mockListTrackedSeasonStates,
    saveWorkflowRunSnapshot: mockSaveWorkflowRunSnapshot,
  })),
  getAccountScopedSettings: vi.fn().mockReturnValue({}),
  getTmdbAccesses: vi.fn().mockResolvedValue([]),
  buildAccountContextResolver: vi.fn().mockReturnValue(() =>
    Promise.resolve({
      storage: {
        listChildDirectories: vi.fn().mockResolvedValue([{ id: "st_1", name: "staging-123" }]),
        listVideoFiles: vi.fn().mockResolvedValue([
          { id: "v1", name: "Show.S01E01.mp4" },
          { id: "v2", name: "Show.S01E01(1).mp4" },
        ]),
      },
      moviesParentDirectoryId: "dir_movies",
      storageParentDirectoryId: "dir_tv",
    }),
  ),
}));

vi.mock("../../../lib/series-target", () => ({
  seriesTargetFor: (...args: unknown[]) => mockSeriesTargetFor(...args),
}));

vi.mock("../titles/organize/organize-handlers", () => ({
  handleMovieOrganize: (...args: unknown[]) => mockHandleMovieOrganize(...args),
  handleTvOrganize: (...args: unknown[]) => mockHandleTvOrganize(...args),
}));

describe("drive-media-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("executeScanDriveMedia", () => {
    it("scans directory and detects untracked media candidates", async () => {
      mockListDirectory.mockResolvedValueOnce({
        items: [
          { id: "f1", name: "Frieren.Beyond.Journeys.End.S01", isFolder: true },
          { id: "f2", name: "Inception.2010", isFolder: true },
        ],
      });
      // child listings
      mockListDirectory.mockResolvedValue({
        items: [{ id: "v1", name: "ep1.mp4", isFolder: false, type: "video" }],
      });
      mockListTrackedSeasonStates.mockResolvedValue([]);

      const result = (await executeScanDriveMedia("acc_1", { folderId: "f_root" })) as {
        ok: boolean;
        candidates: Array<{ folderName: string; isTracked: boolean; videoCount: number }>;
      };

      expect(result.ok).toBe(true);
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0]?.folderName).toContain("Frieren");
      expect(result.candidates[0]?.isTracked).toBe(false);
      expect(result.candidates[0]?.videoCount).toBe(1);
    });
  });

  describe("executeAdoptDriveMedia", () => {
    it("adopts movie folder successfully", async () => {
      mockListDirectory.mockResolvedValue({
        items: [{ id: "v1", name: "Inception.2010.1080p.mp4", isFolder: false, type: "video" }],
      });
      mockAdoptExistingMovie.mockResolvedValue("run_movie_1");

      const result = (await executeAdoptDriveMedia("acc_1", {
        folderId: "f_inception",
        tmdbId: 27205,
        type: "movie",
      })) as { ok: boolean; adopted: boolean; workflowRunId: string; type: string };

      expect(result.ok).toBe(true);
      expect(result.adopted).toBe(true);
      expect(result.workflowRunId).toBe("run_movie_1");
      expect(result.type).toBe("movie");
      expect(mockAdoptExistingMovie).toHaveBeenCalled();
    });

    it("adopts tv folder successfully", async () => {
      mockListDirectory.mockResolvedValue({
        items: [{ id: "v1", name: "Show.S01E01.mp4", isFolder: false, type: "video" }],
      });
      mockSeriesTargetFor.mockResolvedValue({
        title: { id: "title_1", tmdbId: 100, title: "Test TV", type: "tv" },
        seasons: [{ seasonNumber: 1, totalEpisodes: 12, latestAiredEpisode: 12 }],
      });
      mockAdoptExistingTvSeason.mockResolvedValue("run_tv_1");

      const result = (await executeAdoptDriveMedia("acc_1", {
        folderId: "f_tv",
        tmdbId: 100,
        type: "tv",
        seasonNumber: 1,
      })) as { ok: boolean; adopted: boolean; existingEpisodesCount: number };

      expect(result.ok).toBe(true);
      expect(result.adopted).toBe(true);
      expect(result.existingEpisodesCount).toBe(1);
      expect(mockAdoptExistingTvSeason).toHaveBeenCalled();
    });
  });

  describe("executePlanOrganizeMedia", () => {
    it("returns NOT_TRACKED when title not in repository", async () => {
      mockListTrackedSeasonStates.mockResolvedValue([]);

      const result = (await executePlanOrganizeMedia("acc_1", { tmdbId: 999 })) as {
        ok: boolean;
        code: string;
      };

      expect(result.ok).toBe(false);
      expect(result.code).toBe("NOT_TRACKED");
    });

    it("returns dry-run plan details for tracked tv show", async () => {
      mockListTrackedSeasonStates.mockResolvedValue([
        {
          title: { id: "t_1", tmdbId: 100, title: "Test TV", type: "tv" },
          season: { id: "s_1", seasonNumber: 1, storageDirectoryId: "dir_tv_1" },
          connectedStorageId: "storage_1",
        },
      ]);

      const result = (await executePlanOrganizeMedia("acc_1", { tmdbId: 100 })) as {
        ok: boolean;
        stagingDirectories: Array<{ name: string }>;
        duplicateEpisodesCount: number;
        canExecute: boolean;
      };

      expect(result.ok).toBe(true);
      expect(result.stagingDirectories.length).toBe(1);
      expect(result.stagingDirectories[0]?.name).toBe("staging-123");
      expect(result.duplicateEpisodesCount).toBe(1);
      expect(result.canExecute).toBe(true);
    });
  });

  describe("executeExecuteOrganizeMedia", () => {
    it("delegates to handleTvOrganize and returns organized status", async () => {
      mockListTrackedSeasonStates.mockResolvedValue([
        {
          title: { id: "t_1", tmdbId: 100, title: "Test TV", type: "tv" },
          season: { id: "s_1", seasonNumber: 1, storageDirectoryId: "dir_tv_1" },
          connectedStorageId: "storage_1",
        },
      ]);

      mockHandleTvOrganize.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "organized",
            copy: "剧集整理完成",
          }),
      });

      const result = (await executeExecuteOrganizeMedia("acc_1", { tmdbId: 100 })) as {
        ok: boolean;
        status: string;
        copy: string;
      };

      expect(result.ok).toBe(true);
      expect(result.status).toBe("organized");
      expect(result.copy).toContain("剧集整理完成");
      expect(mockHandleTvOrganize).toHaveBeenCalled();
    });
  });
});
