import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET as getDrives } from "./route";

const requireApiAccountMock = vi.fn();
const getAccountConnectedStoragesMock = vi.fn();

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: (req: NextRequest) => requireApiAccountMock(req),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getAccountConnectedStorages: (acct: string) => getAccountConnectedStoragesMock(acct),
}));

describe("Storage Drives API Route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiAccountMock.mockResolvedValue("acct_test");
    getAccountConnectedStoragesMock.mockResolvedValue([
      { id: "cs_1", provider: "115", status: "active", label: "我的115网盘" },
    ]);
  });

  describe("GET /api/storage/drives", () => {
    it("returns 401 if unauthenticated", async () => {
      requireApiAccountMock.mockResolvedValue(
        NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      );

      const req = new NextRequest("http://localhost/api/storage/drives");
      const res = await getDrives(req);
      expect(res.status).toBe(401);
    });

    it("returns connected drives with no-store cache headers", async () => {
      const req = new NextRequest("http://localhost/api/storage/drives");
      const res = await getDrives(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(res.headers.get("Cache-Control")).toContain("must-revalidate");
      expect(res.headers.get("Pragma")).toBe("no-cache");

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.drives).toHaveLength(1);
      expect(data.connectedStorages).toHaveLength(1);
      expect(data.drives[0].id).toBe("cs_1");
    });

    it("handles error and returns 500 with no-store cache headers", async () => {
      getAccountConnectedStoragesMock.mockRejectedValue(new Error("DB error"));

      const req = new NextRequest("http://localhost/api/storage/drives");
      const res = await getDrives(req);
      expect(res.status).toBe(500);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      const data = await res.json();
      expect(data.error).toBe("DB error");
    });
  });
});
