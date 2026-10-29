import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { InMemoryWorkflowRepository, resourceSearchRunId } from "@media-track/workflow";
import { parseImportRequestBody } from "./route";

/**
 * POST /api/titles/import 的行为层测试（批次 3）。
 *
 * 重点断言 plan 批次 3 的验收前三条：
 *   ① candidateId 不属于该 snapshot ⇒ 拒绝
 *   ② 超 30 分钟 ⇒ 拒绝
 *   ③ 导入后徽章/状态可查（这条由 workflowRunId 的存在性覆盖——详情页拿它去轮询）
 * 以及 §3.3：payload 绝不下前端——响应体不含 URL 形态字符串。
 *
 * 与 route.test.ts 不同，这里用**真实**的 InMemoryWorkflowRepository（只 mock 鉴权），
 * 因为要断言的是落库后的可读回性，mock 仓储只能测形状。
 */

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: () => repo,
  resolveGlobalWorkspace: vi.fn().mockResolvedValue({
    accountId: "acct_default",
    connectedStorageId: null,
    basePath: "/",
    activeStorageId: undefined,
  }),
}));

const URL_SHAPE = /(?:https?|magnet):\/\/|ed2k:\/\//i;

const repo = new InMemoryWorkflowRepository();

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/titles/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TITLE = {
  id: "t1",
  tmdbId: 283428,
  type: "tv" as const,
  title: "孤独摇滚",
  originalTitle: "Bocchi the Rock!",
  year: 2022,
  aliases: [],
};

/**
 * 每个用例用不同的 tmdbId。`queueManualImport` 带 blockIfTitleHasActiveRun，同一标题
 * 第二个导入会被判 already_running——共用 tmdbId 会让后一个用例收到 200 而不是 202，
 * 于是它对 202 路径的断言全部空洞（URL 测试就这样假绿过一次）。
 */
let nextTmdbId = 900000;
function freshTmdbId(): number {
  return nextTmdbId++;
}

const SEASON = {
  id: "t1_s1",
  mediaTitleId: "t1",
  seasonNumber: 1,
  status: "active" as const,
  qualityPreference: "4K",
  storageDirectoryId: "d",
  totalEpisodes: 12,
  latestAiredEpisode: 6,
  latestAiredSource: "metadata" as const,
};

/** 落一条搜索 run，返回它的 snapshotId。 */
async function seedSearch(
  createdAt: string,
  candidateIds: string[],
): Promise<{ snapshotId: string; tmdbId: number }> {
  const snapshotId = `snap_${Math.random().toString(36).slice(2, 8)}`;
  const tmdbId = freshTmdbId();
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct_default",
    // id 也要跟着变：标题互斥按媒体标题判定，只换 tmdbId 会让所有用例共用同一个
    // 标题身份，于是前一个用例排的 manual_import 会把后一个判成 already_running。
    title: { ...TITLE, id: `t${tmdbId}`, tmdbId },
    // season 也要跟着派生：仓储会校验 season.mediaTitleId 属于该标题，只改 title.id
    // 会触发 "Tracked season does not belong to media title"。
    season: { ...SEASON, id: `t${tmdbId}_s1`, mediaTitleId: `t${tmdbId}` },
    workflowRun: {
      id: resourceSearchRunId(snapshotId),
      kind: "resource_search",
      status: "succeeded",
      trackedSeasonId: `t${tmdbId}_s1`,
      startedAt: createdAt,
      finishedAt: createdAt,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [
      {
        id: snapshotId,
        provider: "pansou",
        keyword: "孤独摇滚",
        createdAt,
        candidates: candidateIds.map((id, index) => ({
          id,
          snapshotId,
          index,
          title: "孤独摇滚 S01E01",
          type: "115" as const,
          source: "pansou-115",
          // 这正是不能下前端的原始分享链
          providerPayload: { url: "https://115.com/s/leak", password: "abcd" },
        })),
      },
    ],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  return { snapshotId, tmdbId };
}

let POST: (request: NextRequest) => Promise<Response>;

beforeEach(async () => {
  const { requireApiAccount } = await import("../../../../lib/auth-chain");
  vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
  POST = (await import("./route")).POST;
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/titles/import — 请求体校验", () => {
  it("缺 snapshotId 或 candidateId ⇒ 400", async () => {
    for (const bad of [{ tmdbId: 283428 }, { tmdbId: 283428, candidateId: "c1" }, { tmdbId: 283428, snapshotId: "s" }]) {
      const res = await POST(request(bad));
      expect(res.status).toBe(400);
    }
  });

  it("tmdbId 非正整数 ⇒ 400", async () => {
    const res = await POST(request({ tmdbId: 0, snapshotId: "s", candidateId: "c1" }));
    expect(res.status).toBe(400);
  });

  it("非法 JSON ⇒ 400", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/titles/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/titles/import — 快照取回（fail-closed）", () => {
  it("snapshotId 不存在 ⇒ 404", async () => {
    const res = await POST(request({ tmdbId: 283428, snapshotId: "nope", candidateId: "c1" }));
    expect(res.status).toBe(404);
  });

  it("**run 持多份快照时按 id 取对的那份**（不是随手拿第一条）", async () => {
    // resource_search run 恒只持一份合并快照，所以这条在生产里是防御性的；但没有它，
    // 把 find 改成 [0] 不会红——而路由对任何 run 都是通用的，将来多持一份就错。
    const now = new Date().toISOString();
    const tmdbId = freshTmdbId();
    const first = "snap_first";
    const second = "snap_second";
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      title: { ...TITLE, id: `t${tmdbId}`, tmdbId },
      season: { ...SEASON, id: `t${tmdbId}_s1`, mediaTitleId: `t${tmdbId}` },
      workflowRun: {
        id: resourceSearchRunId(second),
        kind: "resource_search",
        status: "succeeded",
        trackedSeasonId: `t${tmdbId}_s1`,
        startedAt: now,
        finishedAt: now,
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [first, second].map((id, index) => ({
        id,
        provider: "pansou",
        keyword: `k${index}`,
        createdAt: now,
        candidates: [
          {
            id: `only_in_${id}`,
            snapshotId: id,
            index: 0,
            title: "t",
            type: "115" as const,
            source: "s",
            providerPayload: { url: `https://115.com/s/${id}` },
          },
        ],
      })),
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    // 请求第二份里的候选：find 取到它 ⇒ 202；[0] 会取到第一份 ⇒ 候选不在其中 ⇒ 410
    const res = await POST(request({ tmdbId, snapshotId: second, candidateId: `only_in_${second}` }));
    expect(res.status).toBe(202);
  });

  it("tmdbId 与快照所属标题不一致 ⇒ 400（否则会用错标题的目录）", async () => {
    const { snapshotId, tmdbId } = await seedSearch(new Date().toISOString(), ["c1"]);
    const res = await POST(request({ tmdbId: tmdbId + 1, snapshotId, candidateId: "c1" }));
    expect(res.status).toBe(400);
  });

  it("snapshotId 属于别的账号 ⇒ 404（不确认它存在）", async () => {
    const { snapshotId, tmdbId } = await seedSearch(new Date().toISOString(), ["c1"]);
    // 改成别的账号所有
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_other");
    const res = await POST(request({ tmdbId, snapshotId, candidateId: "c1" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/titles/import — plan 验收前两条", () => {
  it("① candidateId 不属于该 snapshot ⇒ 410 拒绝", async () => {
    const { snapshotId, tmdbId } = await seedSearch(new Date().toISOString(), ["c1", "c2"]);
    const res = await POST(request({ tmdbId, snapshotId, candidateId: "intruder" }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { reason: string; error: string };
    expect(body.reason).toBe("not_found");
    expect(body.error).toContain("重新查询");
  });

  it("② 超过 30 分钟 ⇒ 410 拒绝", async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { snapshotId, tmdbId } = await seedSearch(stale, ["c1"]);
    const res = await POST(request({ tmdbId, snapshotId, candidateId: "c1" }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("expired");
  });
});

describe("POST /api/titles/import — 放行", () => {
  it("合法候选 ⇒ 202 + workflowRunId，且 run 已落库可读回", async () => {
    const { snapshotId, tmdbId } = await seedSearch(new Date().toISOString(), ["c1", "c2"]);
    const res = await POST(request({ tmdbId, snapshotId, candidateId: "c2" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; workflowRunId: string };
    expect(body.status).toBe("queued");
    expect(body.workflowRunId).toBeTruthy();

    // ③ 徽章可查：详情页拿这个 id 就能看到进度
    const saved = await repo.getWorkflowRunSnapshot(body.workflowRunId, "acct_default");
    expect(saved).not.toBeNull();
    expect(saved!.workflowRun.kind).toBe("manual_import");
    expect(saved!.decisions[0]!.source).toBe("human");
    expect(saved!.decisions[0]!.selectedCandidateIds).toEqual(["c2"]);
  });

  it("**响应体不含 URL 形态**（§3.3：分享链绝不下前端）", async () => {
    const { snapshotId, tmdbId } = await seedSearch(new Date().toISOString(), ["c1"]);
    const res = await POST(request({ tmdbId, snapshotId, candidateId: "c1" }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(URL_SHAPE);
    expect(text).not.toContain("abcd");
  });
});

describe("parseImportRequestBody — 纯函数，无需 HTTP 往返", () => {
  it("三者齐备 ⇒ ok", () => {
    const parsed = parseImportRequestBody({ tmdbId: 283428, snapshotId: "s", candidateId: "c1" });
    expect(parsed).toEqual({ ok: true, tmdbId: 283428, snapshotId: "s", candidateId: "c1" });
  });

  it("非对象 ⇒ invalid body", () => {
    for (const bad of [null, "x", 42, undefined]) {
      expect(parseImportRequestBody(bad).ok).toBe(false);
    }
  });

  it("tmdbId 非正整数 ⇒ 拒绝", () => {
    for (const bad of [0, -1, 1.5, "1", null]) {
      const parsed = parseImportRequestBody({ tmdbId: bad, snapshotId: "s", candidateId: "c" });
      expect(parsed.ok).toBe(false);
    }
  });

  it("缺 snapshotId 或 candidateId ⇒ 拒绝（candidateId 单独没有意义）", () => {
    expect(parseImportRequestBody({ tmdbId: 1, candidateId: "c" }).ok).toBe(false);
    expect(parseImportRequestBody({ tmdbId: 1, snapshotId: "s" }).ok).toBe(false);
    expect(parseImportRequestBody({ tmdbId: 1, snapshotId: "", candidateId: "c" }).ok).toBe(false);
    expect(parseImportRequestBody({ tmdbId: 1, snapshotId: "s", candidateId: "" }).ok).toBe(false);
  });

  it("类型不对的字符串字段 ⇒ 拒绝（不静默转成空串）", () => {
    const parsed = parseImportRequestBody({ tmdbId: 1, snapshotId: 5, candidateId: {} });
    expect(parsed.ok).toBe(false);
  });
});
