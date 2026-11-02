import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseInspectRequestBody, POST } from "./route";

const getWorkflowRunSnapshotMock = vi.fn();

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(async () => "account_1"),
}));

vi.mock("../../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: () => ({
    getWorkflowRunSnapshot: (runId: string, accountId: string) =>
      getWorkflowRunSnapshotMock(runId, accountId),
  }),
}));

describe("parseInspectRequestBody", () => {
  it("有效参数解析成功", () => {
    const parsed = parseInspectRequestBody({
      tmdbId: 100,
      snapshotId: "snap-1",
      candidateId: "cand-1",
    });
    expect(parsed).toEqual({
      ok: true,
      tmdbId: 100,
      snapshotId: "snap-1",
      candidateId: "cand-1",
    });
  });

  it("参数非法时返回错误", () => {
    expect(parseInspectRequestBody({ tmdbId: -1, snapshotId: "s", candidateId: "c" }).ok).toBe(false);
    expect(parseInspectRequestBody({ tmdbId: 100, snapshotId: "", candidateId: "c" }).ok).toBe(false);
  });
});

describe("POST /api/titles/resources/inspect", () => {
  it("成功返回探测结果且响应体绝不包含敏感 URL 或提取码", async () => {
    getWorkflowRunSnapshotMock.mockResolvedValueOnce({
      title: { tmdbId: 100 },
      resourceSnapshots: [
        {
          id: "snap-1",
          candidates: [
            {
              id: "cand-1",
              type: "magnet",
              source: "prowlarr",
              title: "测试磁力资源",
              providerPayload: {
                url: "magnet:?xt=urn:btih:abcdef1234567890",
                sizeBytes: 2048000,
              },
            },
          ],
        },
      ],
    });

    const req = new NextRequest("http://localhost:3000/api/titles/resources/inspect", {
      method: "POST",
      body: JSON.stringify({ tmdbId: 100, snapshotId: "snap-1", candidateId: "cand-1" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidateId).toBe("cand-1");
    expect(body.status).toBe("valid");
    expect(body.totalSizeBytes).toBe(2048000);

    // 结构安全性断言：严禁向前端泄露真实的 URL 和 password 字段
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("magnet:?xt=urn:btih:");
  });
});
