import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseLinkRequestBody, POST } from "./route";

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

describe("parseLinkRequestBody — 请求体校验", () => {
  it("正确校验有效参数", () => {
    const parsed = parseLinkRequestBody({
      tmdbId: 123,
      snapshotId: "snap-1",
      candidateId: "cand-1",
    });
    expect(parsed).toEqual({
      ok: true,
      tmdbId: 123,
      snapshotId: "snap-1",
      candidateId: "cand-1",
    });
  });

  it("拒绝无效 tmdbId 或缺失 id", () => {
    expect(parseLinkRequestBody({ tmdbId: 0, snapshotId: "s", candidateId: "c" }).ok).toBe(false);
    expect(parseLinkRequestBody({ tmdbId: 10, snapshotId: "", candidateId: "c" }).ok).toBe(false);
    expect(parseLinkRequestBody(null).ok).toBe(false);
  });
});

describe("POST /api/titles/resources/link — 真实链接与密码提取", () => {
  it("成功提取夸克网盘链接与提取码并格式化", async () => {
    getWorkflowRunSnapshotMock.mockResolvedValueOnce({
      title: { tmdbId: 100 },
      resourceSnapshots: [
        {
          id: "snap-1",
          candidates: [
            {
              id: "cand-quark",
              type: "quark",
              source: "pansou-quark",
              title: "夸克测试资源",
              providerPayload: {
                url: "https://pan.quark.cn/s/abcdef123456",
                password: "9988",
              },
            },
          ],
        },
      ],
    });

    const req = new NextRequest("http://localhost:3000/api/titles/resources/link", {
      method: "POST",
      body: JSON.stringify({ tmdbId: 100, snapshotId: "snap-1", candidateId: "cand-quark" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.url).toBe("https://pan.quark.cn/s/abcdef123456");
    expect(data.password).toBe("9988");
    expect(data.formatted).toBe("https://pan.quark.cn/s/abcdef123456 提取码: 9988");
    expect(data.isHttp).toBe(true);
    expect(data.isMagnet).toBe(false);
  });

  it("成功提取磁力链接并识别 isMagnet", async () => {
    getWorkflowRunSnapshotMock.mockResolvedValueOnce({
      title: { tmdbId: 200 },
      resourceSnapshots: [
        {
          id: "snap-2",
          candidates: [
            {
              id: "cand-magnet",
              type: "magnet",
              source: "prowlarr",
              title: "磁力测试资源",
              providerPayload: {
                url: "magnet:?xt=urn:btih:deadbeef1234567890",
              },
            },
          ],
        },
      ],
    });

    const req = new NextRequest("http://localhost:3000/api/titles/resources/link", {
      method: "POST",
      body: JSON.stringify({ tmdbId: 200, snapshotId: "snap-2", candidateId: "cand-magnet" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.url).toBe("magnet:?xt=urn:btih:deadbeef1234567890");
    expect(data.formatted).toBe("magnet:?xt=urn:btih:deadbeef1234567890");
    expect(data.isMagnet).toBe(true);
    expect(data.isHttp).toBe(false);
  });

  it("当快照或候选不存在时返回 404", async () => {
    getWorkflowRunSnapshotMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/titles/resources/link", {
      method: "POST",
      body: JSON.stringify({ tmdbId: 300, snapshotId: "missing-snap", candidateId: "c1" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
