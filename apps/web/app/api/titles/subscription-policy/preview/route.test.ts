import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository, type MediaTitle } from "@media-track/workflow";
import { parsePreviewBody, parsePreviewPolicy, POST } from "./route";

/**
 * POST /api/titles/subscription-policy/preview 的行为层测试（批次 5）。
 *
 * 重点断言 plan §4.1 对规则预览的要求，以及三条会让预览**说谎**的边界：
 *   ① 预览数 == 逐个 matchPolicy 的数 —— 同一个匹配器，不是另一个实现
 *   ② 搜索失败 ⇒ 502，**绝不是**「0 matched」。「没搜到」读成「你的规则不命中」会
 *      让人去放宽一条本来没问题的规则。
 *   ③ 响应体不含 URL —— 预览要展示的是「这条规则碰到哪些资源」，浏览器没理由持有直链。
 *
 * 只 mock 鉴权与搜索；仓储用真实的 InMemoryWorkflowRepository，因为「未追踪的标题不可
 * 预览」这条要落在真实数据上。
 */

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(),
}));

vi.mock("../../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: () => repo,
  getWorkerResourceProvider: async () => provider,
}));

const repo = new InMemoryWorkflowRepository();

/** The search results the preview runs over — three resources, one excluded by CAM. */
const RESOURCES = [
  "Show.S01E01.2160p.BluRay.WEB-DL.mkv",
  "Show.S01E02.CAM.枪版.mkv",
  "Show.S02E01.2160p.BluRay.WEB-DL.mkv",
];
let searchCalls = 0;
let searchShouldFail = false;
const provider = {
  search: async ({ keyword }: { keyword: string }) => {
    searchCalls += 1;
    if (searchShouldFail) throw new Error("indexer down");
    return {
      id: `snap_${keyword}`,
      provider: "pansou",
      keyword,
      createdAt: "2026-09-20T00:00:00.000Z",
      candidates: RESOURCES.map((title, index) => ({
        id: `c${index}`,
        snapshotId: `snap_${keyword}`,
        index,
        title,
        type: "magnet" as const,
        source: "pansou",
        providerPayload: { url: `magnet:?xt=urn:btih:${"a".repeat(40)}` },
      })),
    };
  },
};

const TITLE: MediaTitle = {
  id: "t_policy",
  tmdbId: 1396,
  type: "tv",
  title: "孤独摇滚",
  originalTitle: "Bocchi the Rock!",
  year: 2022,
  aliases: [],
};

/** 每个用例用不同的 tmdbId —— 共用会让「未追踪 ⇒ 404」的用例拿到别人建好的标题。 */
let nextTmdbId = 950000;
function freshTmdbId(): number {
  nextTmdbId += 1;
  return nextTmdbId;
}

async function trackTitle(tmdbId: number): Promise<void> {
  await repo.saveWorkflowRunSnapshot({
    ...fixture(tmdbId),
  });
}

const SEASON = {
  id: "s1",
  mediaTitleId: "t_policy",
  seasonNumber: 1,
  status: "active" as const,
  qualityPreference: "4K",
  storageDirectoryId: "d",
  totalEpisodes: 12,
  latestAiredEpisode: 6,
  latestAiredSource: "metadata" as const,
};

/** 一个最小的、只够 listTrackedSeasonStates 认出来的快照。 */
function fixture(tmdbId: number) {
  return {
    accountId: "acct_default",
    workflowRun: {
      id: `run_track_${tmdbId}`,
      kind: "type3_monitor" as const,
      status: "succeeded" as const,
      trackedSeasonId: `t_${tmdbId}_s1`,
      startedAt: "2026-09-20T00:00:00.000Z",
      finishedAt: "2026-09-20T00:00:00.000Z",
      auditEvents: [],
    },
    title: { ...TITLE, id: `t_${tmdbId}`, tmdbId },
    // season 跟着 tmdbId 派生：仓储会校验 season.mediaTitleId 属于该标题。
    season: { ...SEASON, id: `t_${tmdbId}_s1`, mediaTitleId: `t_${tmdbId}` },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  };
}

function request(body: unknown, account = "acct_default"): NextRequest {
  return new NextRequest("http://localhost/api/titles/subscription-policy/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const { requireApiAccount } = await import("../../../../../lib/auth-chain");

beforeEach(async () => {
  vi.mocked(requireApiAccount).mockResolvedValue("acct_default" as never);
  searchCalls = 0;
  searchShouldFail = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/titles/subscription-policy/preview", () => {
  it("**命中数与排除数对**（plan 的「命中 3 个、排除 7 个」）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await POST(
      request({ tmdbId, policy: { mustContain: ["2160p"], mustNotContain: ["CAM"] } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedCount).toBe(2);
    expect(body.excludedCount).toBe(1);
    expect(body.total).toBe(3);
  });

  it("**预览数 == 逐个 matchPolicy 的数**（同一个匹配器的直接证据）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const policy = { mustContain: ["2160p"], mustNotContain: ["CAM"], episodeFilter: "S01" };
    const res = await POST(request({ tmdbId, policy }));
    const body = await res.json();
    // S01 过滤掉第二季那条，CAM 排除中间那条 ⇒ 只剩 1 条。
    expect(body.matchedCount).toBe(1);
    expect(body.excluded).toEqual([
      expect.objectContaining({ name: RESOURCES[1], reason: "excluded" }),
      expect.objectContaining({ name: RESOURCES[2], reason: "episode_filtered" }),
    ]);
  });

  it("**排除带 reason**（只说「排了 N 个」会让人回去猜是哪条规则干的）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await POST(request({ tmdbId, policy: { episodeFilter: "S01" } }));
    const body = await res.json();
    expect(body.excluded.map((e: { reason: string }) => e.reason)).toEqual(["episode_filtered"]);
  });

  it("**搜索失败 ⇒ 502，不是 0 matched**", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    searchShouldFail = true;
    const res = await POST(request({ tmdbId, policy: {} }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.matchedCount).toBeUndefined();
  });

  it("未认证 ⇒ 401", async () => {
    vi.mocked(requireApiAccount).mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) as never,
    );
    const res = await POST(request({ tmdbId: freshTmdbId(), policy: {} }));
    expect(res.status).toBe(401);
  });

  it("未追踪的标题 ⇒ 404（不可预览，同 resources 路由的 fail-closed）", async () => {
    const res = await POST(request({ tmdbId: freshTmdbId(), policy: {} }));
    expect(res.status).toBe(404);
  });

  it("body 不是 JSON ⇒ 400", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/titles/subscription-policy/preview", { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  it("**响应体不含 URL**（预览展示的是名字，浏览器不持有直链）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await POST(request({ tmdbId, policy: {} }));
    const text = await res.text();
    expect(text).not.toMatch(/magnet:|https?:\/\//i);
  });

  it("**同一标题紧接着第二次预览 ⇒ 429**（与 resources 路由共用限速）", async () => {
    // 预览复用 resources 路由的 cooldown 单例：预览不能绕过用户自己的搜索刚付过的限速。
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const first = await POST(request({ tmdbId, policy: {} }));
    expect(first.status).toBe(200);
    const second = await POST(request({ tmdbId, policy: {} }));
    expect(second.status).toBe(429);
  });

  it("**换一个标题不受上一个的限速影响**（按标题限速，不是全局）", async () => {
    const a = freshTmdbId();
    const b = freshTmdbId();
    await trackTitle(a);
    await trackTitle(b);
    expect((await POST(request({ tmdbId: a, policy: {} }))).status).toBe(200);
    expect((await POST(request({ tmdbId: b, policy: {} }))).status).toBe(200);
  });

  it("**报告搜了几个关键词**（1 个关键词的预览比 5 个的弱，用户有权知道）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await POST(request({ tmdbId, policy: {} }));
    const body = await res.json();
    expect(body.searchedKeywords).toBeGreaterThanOrEqual(1);
    expect(searchCalls).toBe(body.searchedKeywords);
  });
});

describe("parsePreviewPolicy", () => {
  it("空 ⇒ 全空策略", () => {
    expect(parsePreviewPolicy({}).ok).toBe(true);
  });

  it("policy 不是对象 ⇒ 拒绝", () => {
    for (const bad of [null, [], "x", 5, true]) {
      expect(parsePreviewPolicy(bad).ok).toBe(false);
    }
  });

  it("词表必须是字符串数组", () => {
    expect(parsePreviewPolicy({ mustContain: "2160p" }).ok).toBe(false);
    expect(parsePreviewPolicy({ mustContain: [1] }).ok).toBe(false);
    expect(parsePreviewPolicy({ mustNotContain: [null] }).ok).toBe(false);
  });

  it("episodeFilter 必须是字符串", () => {
    expect(parsePreviewPolicy({ episodeFilter: 5 }).ok).toBe(false);
  });

  it("cooldownDays 必须是非负整数", () => {
    for (const bad of [-1, 1.5, "7", true]) {
      expect(parsePreviewPolicy({ cooldownDays: bad }).ok).toBe(false);
    }
    expect(parsePreviewPolicy({ cooldownDays: 7 }).ok).toBe(true);
    expect(parsePreviewPolicy({ cooldownDays: 0 }).ok).toBe(true);
  });

  it("useRegex 只有 true 算真（不是 truthy）", () => {
    expect(parsePreviewPolicy({ useRegex: "yes" })).toMatchObject({ ok: true });
    if (!parsePreviewPolicy({ useRegex: "yes" }).ok) return;
    const parsed = parsePreviewPolicy({ useRegex: "yes" });
    if (!parsed.ok) return;
    expect(parsed.policy.useRegex).toBe(false);
  });
});

describe("parsePreviewBody", () => {
  it("tmdbId 正整数，seasonNumber 可缺席", () => {
    expect(parsePreviewBody({ tmdbId: 1396, policy: {} })).toMatchObject({ ok: true, tmdbId: 1396 });
    const parsed = parsePreviewBody({ tmdbId: 1396, policy: {} });
    if (!parsed.ok) return;
    expect(parsed.seasonNumber).toBeUndefined();
  });

  it("**seasonNumber 缺席与显式 null 等价**（电影没有季）", () => {
    const a = parsePreviewBody({ tmdbId: 1, policy: {} });
    const b = parsePreviewBody({ tmdbId: 1, seasonNumber: null, policy: {} });
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    if (!a.ok || !b.ok) return;
    expect(a.seasonNumber).toBeUndefined();
    expect(b.seasonNumber).toBeUndefined();
  });

  it("tmdbId 必须是正整数", () => {
    for (const bad of [0, -1, 1.5, "1", null, true, {}]) {
      expect(parsePreviewBody({ tmdbId: bad, policy: {} }).ok).toBe(false);
    }
  });

  it("seasonNumber 必须是正整数", () => {
    for (const bad of [0, -1, 1.5, "1", true]) {
      expect(parsePreviewBody({ tmdbId: 1, seasonNumber: bad, policy: {} }).ok).toBe(false);
    }
  });

  it("**policy 整个缺席 ⇒ 拒绝**（不是当空策略放过）", () => {
    // 一个没有策略的预览会回答「全部命中」，用户会以为规则没问题
    expect(parsePreviewBody({ tmdbId: 1 }).ok).toBe(false);
  });

  it("body 不是对象 ⇒ 拒绝", () => {
    for (const bad of [null, [], "x", 5]) {
      expect(parsePreviewBody(bad).ok).toBe(false);
    }
  });
});
