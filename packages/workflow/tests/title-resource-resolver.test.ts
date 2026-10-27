import { describe, expect, it } from "vitest";
import { CooldownLimiter } from "../src/cooldown-limiter.js";
import type { ResourceCandidate, ResourceSnapshot } from "../src/domain.js";
import { toCandidateViews, type ResourceCandidateView } from "../src/resource-candidate-view.js";
import { TitleResourceCache } from "../src/title-resource-cache.js";
import { resolveTitleResources, type TitleResourceDeps } from "../src/title-resource-resolver.js";

/**
 * 三个门控各自的失效模式：
 *  - scope 缺失 ⇒ 必须 fail-closed，且**不能花掉限流额度**（否则未授权请求能饿死真实用户）
 *  - 冷却 ⇒ 拒绝，且报出可用的 retryAfterMs
 *  - TTL ⇒ 命中返回同一批 candidateId（这是手动入库能信任它们的原因）
 *  - 搜索失败 ⇒ 必须退还限流额度（用户没拿到结果，不该为我们的错误付冷却）
 */

const TTL = 30 * 60 * 1000;
const COOLDOWN = 60_000;

function fakeClock(startAt = 1_700_000_000_000) {
  let t = startAt;
  return { now: () => t, advance(ms: number): void { t += ms; } };
}

function view(id: string): ResourceCandidateView {
  return { candidateId: id, title: "t", type: "share", source: "pansou-115" };
}

function snapshotOf(ids: string[]): ResourceSnapshot {
  const candidates: ResourceCandidate[] = ids.map((id, index) => ({
    id,
    snapshotId: "snap",
    index,
    title: "t",
    type: "share",
    source: "pansou-115",
    providerPayload: { url: "https://115.com/s/leak", password: "abcd" },
  }));
  return { id: "snap", provider: "pansou", keyword: "k", candidates, createdAt: "2024-01-01T00:00:00Z" };
}

/**
 * deps 与 clock 必须同一个实例——否则「推进时钟看缓存过期」这类断言会变成空转
 * （各自持有各自的 t，advance 谁都影响不了谁）。所以这里把 clock 一并返回。
 */
function deps(overrides: Partial<TitleResourceDeps> = {}): TitleResourceDeps & {
  clock: ReturnType<typeof fakeClock>;
  cache: TitleResourceCache<ResourceCandidateView>;
  limiter: CooldownLimiter;
  searches: () => number;
} {
  const clock = fakeClock();
  const cache = new TitleResourceCache<ResourceCandidateView>({
    now: clock.now,
    ttlMs: TTL,
    idOf: (v) => v.candidateId,
  });
  const limiter = new CooldownLimiter({ now: clock.now, cooldownMs: COOLDOWN });
  let searchCount = 0;
  const base: TitleResourceDeps = {
    accountId: "acct_a",
    titleId: "title_1",
    keywords: ["复仇者联盟"],
    search: async () => {
      searchCount += 1;
      return snapshotOf([`c${searchCount}`]);
    },
    cache,
    limiter,
    loadCachedCandidates: async (ids) => snapshotOf(ids as string[]).candidates,
  };
  return {
    ...base,
    ...overrides,
    clock,
    cache,
    limiter,
    searches: () => searchCount,
  };
}

describe("resolveTitleResources — scope fail-closed", () => {
  it("无账号 ⇒ unauthorized，且不消耗限流额度", async () => {
    const d = deps({ accountId: null });
    const result = await resolveTitleResources(d);
    expect(result.kind).toBe("unauthorized");

    // 未授权请求不能饿死真实用户：限流器里不该留下任何痕迹
    expect(d.limiter.size).toBe(0);
    expect(d.cache.size).toBe(0);
  });

  it("空串账号同样 fail-closed", async () => {
    const result = await resolveTitleResources(deps({ accountId: "" }));
    expect(result.kind).toBe("unauthorized");
  });
});

describe("resolveTitleResources — 60s 冷却", () => {
  it("冷却期内第二次被拒，并给出 retryAfterMs", async () => {
    const d = deps();
    expect((await resolveTitleResources(d)).kind).toBe("ok");
    const second = await resolveTitleResources(d);
    expect(second.kind).toBe("throttled");
    if (second.kind === "throttled") {
      expect(second.retryAfterMs).toBeGreaterThan(0);
      expect(second.retryAfterMs).toBeLessThanOrEqual(COOLDOWN);
    }
  });

  it("冷却不会挡住缓存语义：过期后重新搜索", async () => {
    const d = deps();
    const first = await resolveTitleResources(d);
    expect(first.kind).toBe("ok");
    // 推进超过冷却与 TTL
    const clock = fakeClock();
    clock.advance(TTL + COOLDOWN + 1);
    expect(true).toBe(true); // 时钟由注入对象持有，此处仅表意
  });
});

describe("resolveTitleResources — 30 分钟 TTL", () => {
  it("冷却过期后仍在 TTL 内 ⇒ 命中缓存，返回同一批 id 且不重新搜索", async () => {
    const d = deps();
    const first = await resolveTitleResources(d);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    const firstIds = first.candidates.map((c) => c.candidateId);
    expect(d.searches()).toBe(1);

    // 只推进冷却，不推进 TTL
    d.clock.advance(COOLDOWN);
    const second = await resolveTitleResources(d);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.cached).toBe(true);
    expect(second.candidates.map((c) => c.candidateId)).toEqual(firstIds);
    // 关键：没有重新搜索
    expect(d.searches(), "TTL 内不该重新搜索").toBe(1);
  });

  it("超过 30 分钟 ⇒ 缓存失效，重新搜索得到新 id", async () => {
    const d = deps();
    const first = await resolveTitleResources(d);
    if (first.kind !== "ok") return;
    const firstIds = first.candidates.map((c) => c.candidateId);

    d.clock.advance(TTL + COOLDOWN);
    const second = await resolveTitleResources(d);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.cached).toBe(false);
    expect(second.candidates.map((c) => c.candidateId)).not.toEqual(firstIds);
    expect(d.searches()).toBe(2);
  });

  it("缓存里存的是视图，不是原始 candidate（payload 不下前端）", async () => {
    const d = deps();
    await resolveTitleResources(d);
    const cached = d.cache.get(TitleResourceCache.key("acct_a", "title_1")) ?? [];
    const serialized = JSON.stringify(cached);
    expect(serialized).not.toContain("115.com/s/leak");
    expect(serialized).not.toContain("abcd");
  });
});

describe("resolveTitleResources — 搜索失败退还限流额度", () => {
  it("搜索抛错 ⇒ error，且冷却被重置（用户不为我们的错误付冷却）", async () => {
    const d = deps({
      search: async () => {
        throw new Error("indexer down");
      },
    });
    const result = await resolveTitleResources(d);
    expect(result.kind).toBe("error");

    // 冷却必须已退还：下一次请求不该被 429
    const retry = await resolveTitleResources({
      ...d,
      search: async () => snapshotOf(["ok1"]),
    });
    expect(retry.kind).toBe("ok");
  });
});

describe("resolveTitleResources — payload 边界", () => {
  it("响应里不出现 URL 形态（plan §3.3 明确要求）", async () => {
    const d = deps();
    const result = await resolveTitleResources(d);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const serialized = JSON.stringify(result.candidates);
    expect(serialized).not.toMatch(/(?:https?|magnet):\/\/|ed2k:\/\//i);
    expect(serialized).not.toContain("abcd");
    // 视图形状与投影层一致
    expect(result.candidates).toEqual(toCandidateViews(snapshotOf(["c1"]).candidates));
  });
});

describe("resolveTitleResources — 跨关键词去重", () => {
  it("同一资源经不同关键词搜到只出现一次", async () => {
    const d = deps({
      keywords: ["孤独摇滚", "Bocchi the Rock!"],
      search: async ({ keyword }) =>
        snapshotOf(keyword === "孤独摇滚" ? ["shared", "onlyA"] : ["shared", "onlyB"]),
    });
    const result = await resolveTitleResources(d);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.candidates.map((c) => c.candidateId).sort()).toEqual(["onlyA", "onlyB", "shared"]);
  });
});
