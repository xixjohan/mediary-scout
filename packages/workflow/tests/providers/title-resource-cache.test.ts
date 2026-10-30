import { describe, expect, it } from "vitest";
import { TitleResourceCache } from "../../src/providers/title-resource-cache.js";

/**
 * 30 分钟 TTL 的两半都要测：命中，以及**旧 candidateId 失效**。
 *
 * 后半段最容易写错——一个「只是不再返回旧 id」的缓存等于没失效：批次 3 的手动入库
 * 会拿 candidateId 来取候选，过期的 id 若仍能解析，用户就能导入一个快照里已经不
 * 存在的候选。所以过期必须驱逐，且 hasFreshCandidate 对它持有过的每个 id 都答 false。
 */

const TTL = 30 * 60 * 1000;

/** 可控时钟：测试不睡 30 分钟。 */
function fakeClock(startAt = 1_700_000_000_000) {
  let t = startAt;
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
    },
  };
}

describe("TitleResourceCache — TTL 内命中", () => {
  it("30 分钟内返回同一批 candidateId", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("acct_a", "title_1");

    cache.put(key, ["c1", "c2"]);
    clock.advance(TTL - 1);
    expect(cache.get(key)).toEqual(["c1", "c2"]);
  });

  it("缓存的是副本：调用方改数组不会污染缓存", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    const ids = ["c1"];
    cache.put(key, ids);
    ids.push("c2");
    expect(cache.get(key)).toEqual(["c1"]);
  });
});

describe("TitleResourceCache — 超时后 candidateId 失效", () => {
  it("刚到 30 分钟即过期（>= 边界，不是 >）", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    cache.put(key, ["c1"]);
    clock.advance(TTL);
    expect(cache.get(key)).toBeNull();
  });

  it("过期后旧 candidateId 一律失效（含它曾持有过的）", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    cache.put(key, ["c1", "c2"]);

    expect(cache.hasFreshCandidate(key, "c1")).toBe(true);
    clock.advance(TTL);
    expect(cache.hasFreshCandidate(key, "c1")).toBe(false);
    expect(cache.hasFreshCandidate(key, "c2")).toBe(false);
  });

  it("过期条目被驱逐：再次 put 前一直 miss", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    cache.put(key, ["c1"]);
    clock.advance(TTL * 2);
    expect(cache.get(key)).toBeNull();
    expect(cache.get(key)).toBeNull();
  });

  it("从没缓存的 candidateId 一律 false", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    expect(cache.hasFreshCandidate(TitleResourceCache.key("a", "t"), "nope")).toBe(false);
  });
});

describe("TitleResourceCache — scope 隔离与覆盖", () => {
  it("不同 scope 的同一 titleId 互不串味", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    cache.put(TitleResourceCache.key("acct_a", "t"), ["a1"]);
    cache.put(TitleResourceCache.key("acct_b", "t"), ["b1"]);
    expect(cache.get(TitleResourceCache.key("acct_a", "t"))).toEqual(["a1"]);
    expect(cache.get(TitleResourceCache.key("acct_b", "t"))).toEqual(["b1"]);
  });

  it("重复 put 覆盖旧值", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    cache.put(key, ["old"]);
    cache.put(key, ["new"]);
    expect(cache.get(key)).toEqual(["new"]);
  });

  it("ttlMs 非正数直接抛错（静默接受 0 会让缓存永远失效）", () => {
    expect(() => new TitleResourceCache<string>({ now: () => 0, ttlMs: 0, idOf: (v) => v })).toThrow(/ttlMs/);
    expect(() => new TitleResourceCache<string>({ now: () => 0, ttlMs: -1, idOf: (v) => v })).toThrow(/ttlMs/);
  });
});

describe("TitleResourceCache — 过期条目被真正驱逐", () => {
  it("过期后条目从表里消失（不只是不返回），否则长驻服务内存只增不减", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    const key = TitleResourceCache.key("a", "t");
    cache.put(key, ["c1"]);
    expect(cache.size).toBe(1);

    clock.advance(TTL);
    expect(cache.get(key)).toBeNull();
    expect(cache.size, "过期条目仍留在表里").toBe(0);
  });

  it("未过期的条目不被动到", () => {
    const clock = fakeClock();
    const cache = new TitleResourceCache<string>({ now: clock.now, ttlMs: TTL, idOf: (v) => v });
    cache.put(TitleResourceCache.key("a", "t"), ["c1"]);
    clock.advance(TTL / 2);
    expect(cache.get(TitleResourceCache.key("a", "t"))).toEqual(["c1"]);
    expect(cache.size).toBe(1);
  });
});
