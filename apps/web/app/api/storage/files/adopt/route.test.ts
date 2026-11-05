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
});
