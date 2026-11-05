import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as startScan, GET as getScan } from "./route";
import { POST as reviewScan } from "./review/route";

const fakeManager = {
  listDirectory: vi.fn(),
};

const mockJob = {
  id: "job_123",
  accountId: "acct_test",
  storageId: "cs_1",
  targetCid: "root_cid",
  category: "auto",
  status: "completed",
  totalFolders: 10,
  scannedFolders: 10,
  discoveredTitles: 2,
  autoIngestedTitles: 1,
  pendingReviewTitles: 1,
  progressPercent: 100,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const mockItem = {
  id: "item_456",
  jobId: "job_123",
  accountId: "acct_test",
  folderId: "dir_pending",
  folderName: "未知老片",
  relativePath: "未知老片",
  confidence: 60,
  reviewStatus: "pending_review",
  discoveredFilesJson: "[]",
};

const mockRepo = {
  getConnectedStorageById: vi.fn(async () => ({
    id: "cs_1",
    provider: "pan115",
    rootCid: "root_cid",
  })),
  createReverseScanJob: vi.fn(async () => mockJob),
  getReverseScanJob: vi.fn(async () => mockJob),
  listReverseScanJobs: vi.fn(async () => [mockJob]),
  listReverseScanItems: vi.fn(async () => [mockItem]),
  updateReverseScanItem: vi.fn(async () => {}),
  updateReverseScanJob: vi.fn(async () => {}),
  saveWorkflowRunSnapshot: vi.fn(async () => {}),
};

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(async () => "acct_test"),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: vi.fn(async () => fakeManager),
}));

vi.mock("../../../../composition/runtime-container", () => ({
  getWorkflowRepository: vi.fn(() => mockRepo),
}));

vi.mock("../../../settings-system/application/system-settings-service", () => ({
  getAccountScopedSettings: vi.fn(() => ({})),
}));

vi.mock("../../../../lib/runtime/settings-readers", () => ({
  getTmdbAccesses: vi.fn(async () => []),
}));

describe("/api/storage/scan API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeManager.listDirectory.mockResolvedValue({ items: [] });
  });

  describe("POST /api/storage/scan", () => {
    it("returns 400 when storageId is missing", async () => {
      const req = new NextRequest("http://localhost/api/storage/scan", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const res = await startScan(req);
      expect(res.status).toBe(400);
    });

    it("creates job and returns it on success", async () => {
      const req = new NextRequest("http://localhost/api/storage/scan", {
        method: "POST",
        body: JSON.stringify({ storageId: "cs_1" }),
      });
      const res = await startScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.job.id).toBe("job_123");
    });
  });

  describe("GET /api/storage/scan", () => {
    it("returns job and items when jobId is passed", async () => {
      const req = new NextRequest("http://localhost/api/storage/scan?jobId=job_123");
      const res = await getScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.job.id).toBe("job_123");
      expect(data.items).toHaveLength(1);
    });

    it("returns list of jobs when jobId is omitted", async () => {
      const req = new NextRequest("http://localhost/api/storage/scan");
      const res = await getScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.jobs).toHaveLength(1);
    });
  });

  describe("POST /api/storage/scan/review", () => {
    it("handles ignore action", async () => {
      const req = new NextRequest("http://localhost/api/storage/scan/review", {
        method: "POST",
        body: JSON.stringify({
          jobId: "job_123",
          itemId: "item_456",
          action: "ignore",
        }),
      });
      const res = await reviewScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(mockRepo.updateReverseScanItem).toHaveBeenCalledWith("item_456", { reviewStatus: "ignored" });
    });

    it("handles accept action", async () => {
      fakeManager.listDirectory.mockResolvedValue({
        items: [{ id: "v1", name: "movie.mp4", isFolder: false, sizeBytes: 1024, type: "video" }],
      });

      const req = new NextRequest("http://localhost/api/storage/scan/review", {
        method: "POST",
        body: JSON.stringify({
          jobId: "job_123",
          itemId: "item_456",
          action: "accept",
          tmdbId: 888,
          mediaType: "movie",
          title: "确认电影",
        }),
      });
      const res = await reviewScan(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(mockRepo.saveWorkflowRunSnapshot).toHaveBeenCalled();
    });
  });
});
