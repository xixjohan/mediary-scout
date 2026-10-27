import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository, type MediaTitle } from "@media-track/workflow";
import { parseSubscriptionPolicyWrite, GET, PUT } from "./route";

/**
 * GET/PUT /api/titles/subscription-policy 的行为层测试（批次 5）。
 *
 * 重点断言两条会让策略层**静默失效**的边界：
 *   ① 看不懂的 episodeFilter ⇒ 400，**绝不**存进去。存了它就等于把订阅悄悄关掉——
 *      parseEpisodeFilter 读不出的 filter 排除一切（见 subscription-policy.ts），
 *      而这个错要到一周后「怎么什么都不下」才发现。
 *   ② GET 对没配过的作品返回 **null**，不是空策略。面板要能说「你还没给这部配规则」，
 *      这和「你的规则排除了一切」是两句话；空策略会让这两句无法区分。
 *
 * 只 mock 鉴权；仓储用真实的 InMemoryWorkflowRepository——「未追踪不可配置」与
 * 「写完读得回」都要落在真实数据上。
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
}));

const repo = new InMemoryWorkflowRepository();

const TITLE: MediaTitle = {
  id: "t_policy_save",
  tmdbId: 1396,
  type: "tv",
  title: "孤独摇滚",
  originalTitle: "Bocchi the Rock!",
  year: 2022,
  aliases: [],
};

const SEASON = {
  id: "s1",
  mediaTitleId: "t_policy_save",
  seasonNumber: 1,
  status: "active" as const,
  qualityPreference: "4K",
  storageDirectoryId: "d",
  totalEpisodes: 12,
  latestAiredEpisode: 6,
  latestAiredSource: "metadata" as const,
};

let nextTmdbId = 970000;
function freshTmdbId(): number {
  nextTmdbId += 1;
  return nextTmdbId;
}

async function trackTitle(tmdbId: number): Promise<string> {
  const titleId = `t_${tmdbId}`;
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct_default",
    workflowRun: {
      id: `run_track_${tmdbId}`,
      kind: "type3_monitor" as const,
      status: "succeeded" as const,
      trackedSeasonId: `${titleId}_s1`,
      startedAt: "2026-09-20T00:00:00.000Z",
      finishedAt: "2026-09-20T00:00:00.000Z",
      auditEvents: [],
    },
    title: { ...TITLE, id: titleId, tmdbId },
    season: { ...SEASON, id: `${titleId}_s1`, mediaTitleId: titleId },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  return titleId;
}

const POLICY = {
  mustContain: ["2160p"],
  mustNotContain: ["CAM"],
  episodeFilter: "S01-S02",
  useRegex: false,
  cooldownDays: 3,
};

function put(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/titles/subscription-policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(tmdbId: number): NextRequest {
  return new NextRequest(`http://localhost/api/titles/subscription-policy?tmdbId=${tmdbId}`, {
    method: "GET",
  });
}

const { requireApiAccount } = await import("../../../../lib/auth-chain");

beforeEach(async () => {
  vi.mocked(requireApiAccount).mockResolvedValue("acct_default" as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/titles/subscription-policy", () => {
  it("保存后读得回（五字段无损）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await PUT(put({ tmdbId, policy: POLICY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toMatchObject(POLICY);
  });

  it("**看不懂的 episodeFilter ⇒ 400，绝不存进去**", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await PUT(put({ tmdbId, policy: { ...POLICY, episodeFilter: "第一季" } }));
    expect(res.status).toBe(400);
    // 更要紧的是：库里没有留下这条策略
    const after = await GET(get(tmdbId));
    expect((await after.json()).policy).toBeNull();
  });

  it("**合法 filter 的各种形态都收**（用户最常写的几种）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    for (const filter of ["", "S01-S03", "E01-E10", "S02E05", "S01", "E01", "05", "S01-S02;E01-E05"]) {
      const res = await PUT(put({ tmdbId, policy: { ...POLICY, episodeFilter: filter } }));
      expect(res.status, `filter=${filter}`).toBe(200);
    }
  });

  it("未认证 ⇒ 401", async () => {
    vi.mocked(requireApiAccount).mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) as never,
    );
    expect((await PUT(put({ tmdbId: freshTmdbId(), policy: POLICY }))).status).toBe(401);
  });

  it("未追踪的标题 ⇒ 404", async () => {
    expect((await PUT(put({ tmdbId: freshTmdbId(), policy: POLICY }))).status).toBe(404);
  });

  it("body 不是 JSON ⇒ 400", async () => {
    const res = await PUT(
      new NextRequest("http://localhost/api/titles/subscription-policy", { method: "PUT" }),
    );
    expect(res.status).toBe(400);
  });

  it("tmdbId 必须是正整数", async () => {
    for (const bad of [0, -1, 1.5, "1", null, true]) {
      const res = await PUT(put({ tmdbId: bad, policy: POLICY }));
      expect(res.status, `tmdbId=${String(bad)}`).toBe(400);
    }
  });
});

describe("GET /api/titles/subscription-policy", () => {
  it("**没配过 ⇒ null**（不是空策略）", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    const res = await GET(get(tmdbId));
    expect(res.status).toBe(200);
    expect((await res.json()).policy).toBeNull();
  });

  it("配过 ⇒ 返回那份策略", async () => {
    const tmdbId = freshTmdbId();
    await trackTitle(tmdbId);
    await PUT(put({ tmdbId, policy: POLICY }));
    const res = await GET(get(tmdbId));
    expect((await res.json()).policy).toMatchObject(POLICY);
  });

  it("**同一个作品不同 account 互不可见**", async () => {
    const tmdbId = freshTmdbId();
    const titleId = await trackTitle(tmdbId);
    await repo.upsertSubscriptionPolicy({
      accountId: "acct_other",
      titleKey: titleId,
      policy: POLICY,
      now: "2026-09-20T00:00:00.000Z",
    });
    // acct_default 视角下仍是没配过
    expect((await (await GET(get(tmdbId))).json()).policy).toBeNull();
  });

  it("缺 tmdbId ⇒ 400", async () => {
    expect((await GET(new NextRequest("http://localhost/api/titles/subscription-policy", { method: "GET" }))).status).toBe(400);
  });

  it("未认证 ⇒ 401", async () => {
    vi.mocked(requireApiAccount).mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) as never,
    );
    expect((await GET(get(freshTmdbId()))).status).toBe(401);
  });
});

describe("parseSubscriptionPolicyWrite", () => {
  it("空 ⇒ 合法（不排除任何东西、不要求任何东西）", () => {
    const parsed = parseSubscriptionPolicyWrite({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.policy).toEqual({
      mustContain: [],
      mustNotContain: [],
      episodeFilter: "",
      useRegex: false,
      cooldownDays: 0,
    });
  });

  it("policy 不是对象 ⇒ 拒绝", () => {
    for (const bad of [null, [], "x", 5, true]) {
      expect(parseSubscriptionPolicyWrite(bad).ok).toBe(false);
    }
  });

  it("词表必须是字符串数组", () => {
    expect(parseSubscriptionPolicyWrite({ mustContain: "2160p" }).ok).toBe(false);
    expect(parseSubscriptionPolicyWrite({ mustContain: [1] }).ok).toBe(false);
    expect(parseSubscriptionPolicyWrite({ mustNotContain: [null] }).ok).toBe(false);
  });

  it("cooldownDays 必须是非负整数", () => {
    for (const bad of [-1, 1.5, "7", true]) {
      expect(parseSubscriptionPolicyWrite({ cooldownDays: bad }).ok).toBe(false);
    }
  });

  it("useRegex 只有 true 算真（不是 truthy）", () => {
    const parsed = parseSubscriptionPolicyWrite({ useRegex: "yes" });
    if (!parsed.ok) throw new Error("should be ok");
    expect(parsed.policy.useRegex).toBe(false);
  });
});
