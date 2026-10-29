import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET as getFiles } from "./route";
import { POST as createFolder } from "./folder/route";
import { POST as renameItem } from "./rename/route";
import { POST as deleteItems } from "./delete/route";
import { POST as moveItems } from "./move/route";
import { POST as copyItems } from "./copy/route";

const fakeManager = {
  listDirectory: vi.fn(),
  createFolder: vi.fn(),
  renameItem: vi.fn(),
  deleteItems: vi.fn(),
  moveItems: vi.fn(),
  copyItems: vi.fn(),
};

const requireApiAccountMock = vi.fn();
const getAccountDriveFileManagerMock = vi.fn();

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: (req: NextRequest) => requireApiAccountMock(req),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: (acct: string, storageId?: string | null) =>
    getAccountDriveFileManagerMock(acct, storageId),
}));

vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: vi.fn(() => false),
}));

describe("Storage Files API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiAccountMock.mockResolvedValue("acct_test");
    getAccountDriveFileManagerMock.mockResolvedValue(fakeManager);
  });

  describe("GET /api/storage/files", () => {
    it("returns 401 if unauthenticated", async () => {
      requireApiAccountMock.mockResolvedValue(
        NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      );

      const req = new NextRequest("http://localhost/api/storage/files?storageId=cs_1");
      const res = await getFiles(req);
      expect(res.status).toBe(401);
    });

    it("returns 404 if no drive file manager found", async () => {
      getAccountDriveFileManagerMock.mockResolvedValue(null);

      const req = new NextRequest("http://localhost/api/storage/files?storageId=cs_none");
      const res = await getFiles(req);
      expect(res.status).toBe(404);
    });

    it("returns directory listing on success", async () => {
      fakeManager.listDirectory.mockResolvedValue({
        storageId: "cs_1",
        provider: "quark",
        currentDirectoryId: "dir_root",
        currentDirectoryName: "根目录",
        items: [],
        totalCount: 0,
        folderCount: 0,
        fileCount: 0,
        totalSizeBytes: 0,
        breadcrumbs: [],
        rootCid: "dir_root",
        moviesCid: null,
        tvCid: null,
        animeCid: null,
      });

      const req = new NextRequest("http://localhost/api/storage/files?storageId=cs_1&dirId=dir_root");
      const res = await getFiles(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentDirectoryId).toBe("dir_root");
      expect(fakeManager.listDirectory).toHaveBeenCalledWith("dir_root");
    });
  });

  describe("POST /api/storage/files/folder", () => {
    it("rejects empty folder name", async () => {
      const req = new NextRequest("http://localhost/api/storage/files/folder", {
        method: "POST",
        body: JSON.stringify({ parentId: "p1", name: "   " }),
      });
      const res = await createFolder(req);
      expect(res.status).toBe(400);
    });

    it("creates folder successfully", async () => {
      fakeManager.createFolder.mockResolvedValue({ id: "new_1", name: "New Folder" });

      const req = new NextRequest("http://localhost/api/storage/files/folder", {
        method: "POST",
        body: JSON.stringify({ parentId: "p1", name: "New Folder" }),
      });
      const res = await createFolder(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("new_1");
      expect(fakeManager.createFolder).toHaveBeenCalledWith({ parentId: "p1", name: "New Folder" });
    });
  });

  describe("POST /api/storage/files/rename", () => {
    it("renames item successfully", async () => {
      fakeManager.renameItem.mockResolvedValue(undefined);

      const req = new NextRequest("http://localhost/api/storage/files/rename", {
        method: "POST",
        body: JSON.stringify({ itemId: "f1", newName: "Renamed", isFolder: true }),
      });
      const res = await renameItem(req);
      expect(res.status).toBe(200);
      expect(fakeManager.renameItem).toHaveBeenCalledWith({ itemId: "f1", newName: "Renamed", isFolder: true });
    });
  });

  describe("POST /api/storage/files/delete", () => {
    it("deletes items successfully", async () => {
      fakeManager.deleteItems.mockResolvedValue({ deletedCount: 2 });

      const req = new NextRequest("http://localhost/api/storage/files/delete", {
        method: "POST",
        body: JSON.stringify({
          items: [
            { id: "f1", isFolder: false, name: "file1.mp4" },
            { id: "f2", isFolder: true, name: "folder1" },
          ],
        }),
      });
      const res = await deleteItems(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deletedCount).toBe(2);
      expect(fakeManager.deleteItems).toHaveBeenCalled();
    });
  });

  describe("POST /api/storage/files/move", () => {
    it("rejects moving folder into itself", async () => {
      const req = new NextRequest("http://localhost/api/storage/files/move", {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "target_dir", isFolder: true }],
          targetDirectoryId: "target_dir",
        }),
      });
      const res = await moveItems(req);
      expect(res.status).toBe(400);
    });

    it("moves items successfully", async () => {
      fakeManager.moveItems.mockResolvedValue({ movedCount: 1 });

      const req = new NextRequest("http://localhost/api/storage/files/move", {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "f1", isFolder: false }],
          targetDirectoryId: "target_dir_2",
        }),
      });
      const res = await moveItems(req);
      expect(res.status).toBe(200);
      expect(fakeManager.moveItems).toHaveBeenCalledWith({
        items: [{ id: "f1", isFolder: false }],
        targetDirectoryId: "target_dir_2",
      });
    });
  });

  describe("POST /api/storage/files/copy", () => {
    it("copies items successfully", async () => {
      fakeManager.copyItems.mockResolvedValue({ copiedCount: 1 });

      const req = new NextRequest("http://localhost/api/storage/files/copy", {
        method: "POST",
        body: JSON.stringify({
          items: [{ id: "f1", isFolder: false }],
          targetDirectoryId: "target_dir_2",
        }),
      });
      const res = await copyItems(req);
      expect(res.status).toBe(200);
      expect(fakeManager.copyItems).toHaveBeenCalledWith({
        items: [{ id: "f1", isFolder: false }],
        targetDirectoryId: "target_dir_2",
      });
    });
  });
});
