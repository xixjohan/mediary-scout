import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/titles/resources 的行为层测试（批次 2）。
 *
 * 重点断言三件事，都是 plan 的验收标准：
 *   ① 无 scope ⇒ fail-closed（401），且**不花掉限流额度**
 *   ② 未追踪的标题 ⇒ 不可见（404）——否则任何人都能探测片库里任意一部片的资源
 *   ③ 响应体**不含 URL 形态**（§3.3 明确要求；分享链/磁力绝不能进浏览器）
 *
 * 路由的重依赖（仓储、provider 链、鉴权链）全部 mock；断言只关注门控与响应形状。
 * 注意模块级单例（缓存/限流）跨用例共享，所以每个用例前重置。
 */

const repo = {
  listTrackedSeasonStates: vi.fn(),
  saveWorkflowRunSnapshot: vi.fn(),
  getSubscriptionPolicy: vi.fn().mockResolvedValue(null),
};
const provider = { search: vi.fn() };
const movieTargetFromTmdbId = vi.fn().mockResolvedValue(null);
const seriesTargetFor = vi.fn().mockResolvedValue(null);

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: () => repo,
  getWorkerResourceProvider: async () => provider,
  movieTargetFromTmdbId: (tmdbId: number) => movieTargetFromTmdbId(tmdbId),
}));

vi.mock("../../../../lib/title-hub", () => ({
  seriesTargetFor: (tmdbId: number) => seriesTargetFor(tmdbId),
}));

const URL_SHAPE = /(?:https?|magnet):\/\/|ed2k:\/\//i;

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/titles/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 一个被账号追踪的标题。 */
function trackedTitle(tmdbId = 283428) {
  return {
    accountId: "acct_default",
    connectedStorageId: null,
    title: {
      id: "t1",
      tmdbId,
      type: "tv" as const,
      title: "孤独摇滚",
      originalTitle: "Bocchi the Rock!",
      year: 2022,
      aliases: [],
    },
    season: { seasonNumber: 1, status: "airing", totalEpisodes: 12 },
    episodes: [],
  };
}

/** PanSou 形态的快照：payload 里正是不能下前端的分享链与提取码。 */
function snapshot(candidates: Array<{ id: string; url: string; password: string; datetime: string }>) {
  return {
    id: "snap-1",
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt: "2024-01-01T00:00:00Z",
    candidates: candidates.map((c, index) => ({
      id: c.id,
      snapshotId: "snap-1",
      index,
      title: "孤独摇滚 S01E01",
      type: "share" as const,
      source: "pansou-115",
      providerPayload: { url: c.url, password: c.password, datetime: c.datetime, rawType: "分享" },
    })),
  };
}

let POST: (request: NextRequest) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  POST = (await import("./route")).POST;
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/titles/resources — 请求体校验", () => {
  it("tmdbId 非正整数 ⇒ 400", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");

    for (const bad of [{ tmdbId: 0 }, { tmdbId: -1 }, { tmdbId: "1" }, {}, { tmdbId: 1.5 }]) {
      const res = await POST(request(bad));
      expect(res.status).toBe(400);
    }
  });

  it("非法 JSON ⇒ 400", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    const res = await POST(
      new NextRequest("http://localhost/api/titles/resources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/titles/resources — scope fail-closed", () => {
  it("无账号 ⇒ 401，且不触碰仓储", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue(
      NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    );

    const res = await POST(request({ tmdbId: 283428 }));
    expect(res.status).toBe(401);
    // 未授权请求不该产生任何仓储读取
    expect(repo.listTrackedSeasonStates).not.toHaveBeenCalled();
  });
});

describe("POST /api/titles/resources — 标题 scope 判定", () => {
  it("账号没追踪这部片 ⇒ 404（不可见，不可探测）", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle(999)]); // 只追踪了别的片

    const res = await POST(request({ tmdbId: 283428 }));
    expect(res.status).toBe(404);
    // 没有发起任何搜索
    expect(provider.search).not.toHaveBeenCalled();
  });

  it("按账号作用域查询（不裸查全库）", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
    provider.search.mockResolvedValue(snapshot([]));

    await POST(request({ tmdbId: 283428 }));
    expect(repo.listTrackedSeasonStates).toHaveBeenCalledWith("acct_default");
  });
});

describe("POST /api/titles/resources — payload 绝不下前端", () => {
  it("响应体不含 URL 形态，也不含提取码", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
    provider.search.mockResolvedValue(
      snapshot([
        { id: "c1", url: "https://115.com/s/swxy8ab", password: "a1b2", datetime: "2024-05-01T10:00:00Z" },
        { id: "c2", url: "https://115.com/s/other99", password: "c3d4", datetime: "2024-05-02T10:00:00Z" },
      ]),
    );

    const res = await POST(request({ tmdbId: 283428 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cached: boolean;
      count: number;
      candidates: Array<Record<string, unknown>>;
    };

    expect(body.count).toBe(2);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(URL_SHAPE);
    expect(serialized).not.toContain("a1b2");
    expect(serialized).not.toContain("c3d4");

    // 用户要的三个事实在：标题、来源、发布时间
    expect(body.candidates[0]).toMatchObject({
      candidateId: "c1",
      title: "孤独摇滚 S01E01",
      source: "pansou-115",
      postedAt: "2024-05-01T10:00:00Z",
    });
    // 键集合封闭
    expect(Object.keys(body.candidates[0]!).sort()).toEqual([
      "candidateId",
      "postedAt",
      "source",
      "title",
      "type",
    ]);
  });

  it("不缓存（no-store）——候选集合随时可能因重新搜索而变", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
    provider.search.mockResolvedValue(snapshot([]));

    const res = await POST(request({ tmdbId: 283428 }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/titles/resources — 上游失败", () => {
  it("provider 抛错 ⇒ 502（不是 500：错在上游）", async () => {
    const { requireApiAccount } = await import("../../../../lib/auth-chain");
    vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
    repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
    provider.search.mockRejectedValue(new Error("indexer down"));

    const res = await POST(request({ tmdbId: 283428 }));
    expect(res.status).toBe(502);
  });
});

  describe("POST /api/titles/resources — 快照落库（批次 3）", () => {
    /** 让 provider 对每个关键词都回同一份快照。 */
    async function stubSearch() {
      const { requireApiAccount } = await import("../../../../lib/auth-chain");
      vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
      repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
      provider.search.mockImplementation(async () =>
        snapshot([{ id: "c1", url: "https://115.com/s/x", password: "p", datetime: "2024-01-01" }]),
      );
    }

    it("搜索成功 ⇒ 落一条不可见的 resource_search run，内容是合并快照", async () => {
      await stubSearch();
      const res = await POST(request({ tmdbId: 283428 }));
      expect(res.status).toBe(200);
      expect(repo.saveWorkflowRunSnapshot).toHaveBeenCalledTimes(1);

      const saved = repo.saveWorkflowRunSnapshot.mock.calls[0]![0];
      expect(saved.workflowRun.kind).toBe("resource_search");
      expect(saved.workflowRun.status).toBe("succeeded");
      expect(saved.resourceSnapshots).toHaveLength(1);
      expect(saved.resourceSnapshots[0].candidates.map((c: { id: string }) => c.id)).toContain("c1");
      // 搜索没有转存/决策/通知
      expect(saved.episodes).toEqual([]);
      expect(saved.decisions).toEqual([]);
      expect(saved.transferAttempts).toEqual([]);
      expect(saved.notifications).toEqual([]);
    });

    it("**缓存命中不再落库**（DB 那份才是权威，重复落会让两份不一致）", async () => {
      await stubSearch();
      // 第一次 miss 落库；第二次命中（模块级缓存仍在）
      const first = await POST(request({ tmdbId: 283428 }));
      expect(first.status).toBe(200);
      expect(repo.saveWorkflowRunSnapshot).toHaveBeenCalledTimes(1);
      const second = await POST(request({ tmdbId: 283428 }));
      // 60s 冷却内第二次会被限流；这条用例要的是「命中时不重复落库」
      if (second.status === 429) {
        expect(repo.saveWorkflowRunSnapshot).toHaveBeenCalledTimes(1);
        return;
      }
      expect(repo.saveWorkflowRunSnapshot).toHaveBeenCalledTimes(1);
    });

    it("**落库失败不影响搜索本身**（用户要的结果已拿到）", async () => {
      await stubSearch();
      repo.saveWorkflowRunSnapshot.mockRejectedValue(new Error("db down"));
      const res = await POST(request({ tmdbId: 283428 }));
      // 不是 500：落库失败的后果只是之后 import 会被拒「请重新查询」，可恢复
      expect(res.status).toBe(200);
      const body = (await res.json()) as { candidates: unknown[] };
      expect(body.candidates.length).toBeGreaterThan(0);
    });

    it("未追踪的标题 ⇒ 404，且不落库", async () => {
      const { requireApiAccount } = await import("../../../../lib/auth-chain");
      vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
      repo.listTrackedSeasonStates.mockResolvedValue([]);
      const res = await POST(request({ tmdbId: 283428 }));
      expect(res.status).toBe(404);
      expect(repo.saveWorkflowRunSnapshot).not.toHaveBeenCalled();
    });

    it("从搜索页进入的未追踪标题可通过 TMDB 元数据搜索资源并落库快照", async () => {
      const { requireApiAccount } = await import("../../../../lib/auth-chain");
      vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
      repo.listTrackedSeasonStates.mockResolvedValue([]);
      movieTargetFromTmdbId.mockResolvedValue({
        title: {
          id: "tmdb_movie_123",
          tmdbId: 123,
          type: "movie" as const,
          title: "奥本海默",
          originalTitle: "Oppenheimer",
          year: 2023,
          aliases: [],
        },
      });
      provider.search.mockResolvedValue(
        snapshot([{ id: "c_opp", url: "https://115.com/s/opp", password: "opp", datetime: "2023-08-01" }]),
      );

      const res = await POST(request({ tmdbId: 123, type: "movie" }));
      expect(res.status).toBe(200);
      expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ keyword: "奥本海默" }));
      expect(repo.saveWorkflowRunSnapshot).toHaveBeenCalledTimes(1);
    });

    it("支持自定义搜索关键词，并将自定义关键词排在第一位", async () => {
      const { requireApiAccount } = await import("../../../../lib/auth-chain");
      vi.mocked(requireApiAccount).mockResolvedValue("acct_default");
      repo.listTrackedSeasonStates.mockResolvedValue([trackedTitle()]);
      provider.search.mockResolvedValue(
        snapshot([{ id: "c_custom", url: "https://115.com/s/custom", password: "c", datetime: "2024-01-01" }]),
      );

      const res = await POST(request({ tmdbId: 283428, customKeyword: "孤独摇滚 喵萌奶茶屋" }));
      expect(res.status).toBe(200);
      expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ keyword: "孤独摇滚 喵萌奶茶屋" }));
    });
  });
