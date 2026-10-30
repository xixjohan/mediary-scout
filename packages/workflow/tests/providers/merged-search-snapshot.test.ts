import { describe, expect, it } from "vitest";
import type { ResourceCandidate, ResourceSnapshot } from "../../src/domain.js";
import { buildMergedSearchSnapshot } from "../../src/merged-search-snapshot.js";
import { resolveManualImportCandidate } from "../../src/manual-import-resolver.js";

/**
 * 批次 3：把关键词阶梯的多份快照合并成用户看到的那一份。
 *
 * 没有它，import 的「candidateId 属于这份快照吗」会有歧义——同一个 candidateId 在
 * 两份快照里带着两个不同的 snapshotId。最后一条用例直接钉这个合并是为了 import 可用。
 */

const CREATED_AT = "2024-05-01T10:00:00Z";

function candidate(id: string, snapshotId: string, index = 0): ResourceCandidate {
  return {
    id,
    snapshotId,
    index,
    title: `资源 ${id}`,
    type: "115",
    source: "pansou-115",
    providerPayload: { url: `https://115.com/s/${id}`, password: "p" },
  };
}

function snapshot(id: string, keyword: string, candidates: ResourceCandidate[]): ResourceSnapshot {
  return { id, provider: "pansou", keyword, createdAt: CREATED_AT, candidates };
}

describe("buildMergedSearchSnapshot", () => {
  it("同一 candidateId 跨关键词只出现一次（面板不会把同一条链接显示三遍）", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["孤独摇滚", "Bocchi the Rock!"],
      snapshots: [
        snapshot("s1", "孤独摇滚", [candidate("c1", "s1"), candidate("c2", "s1", 1)]),
        snapshot("s2", "Bocchi the Rock!", [candidate("c1", "s2"), candidate("c3", "s2", 1)]),
      ],
      createdAt: CREATED_AT,
    });
    expect(merged.candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("**重贴 snapshotId**——否则 candidateBelongsToSnapshot 会拒绝每一个候选", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["孤独摇滚", "Bocchi the Rock!"],
      snapshots: [snapshot("s1", "孤独摇滚", [candidate("c1", "s1")]), snapshot("s2", "原名", [candidate("c2", "s2")])],
      createdAt: CREATED_AT,
    });
    for (const c of merged.candidates) {
      expect(c.snapshotId).toBe("merged-1");
    }
  });

  it("**先出现者胜出**——同一 id 两份不同 payload 时取第一个关键词的（确定性）", () => {
    // 这一条是变异测试逼出来的：去掉 `if (byId.has(...)) continue` 时上面的去重用例
    // 全绿——因为 Map.set 本身就去重，那行真正决定的是**哪一个出现胜出**。夹具里两份
    // 内容相同所以看不出差别。内容哈希型 provider 理论上同 id 同内容，但一旦不同，
    // 「取哪个」必须是确定的，否则同一次搜索重跑可能给出不同的 payload。
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["a", "b"],
      snapshots: [
        snapshot("s1", "a", [{ ...candidate("c1", "s1"), providerPayload: { url: "first" } }]),
        snapshot("s2", "b", [{ ...candidate("c1", "s2"), providerPayload: { url: "second" } }]),
      ],
      createdAt: CREATED_AT,
    });
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]!.providerPayload).toEqual({ url: "first" });
  });

  it("index 重排成连续 0..n-1（合并后顺序字段不能留旧值）", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["a", "b"],
      snapshots: [
        snapshot("s1", "a", [candidate("c1", "s1", 0), candidate("c2", "s1", 1)]),
        snapshot("s2", "b", [candidate("c3", "s2", 0), candidate("c4", "s2", 5)]),
      ],
      createdAt: CREATED_AT,
    });
    expect(merged.candidates.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });

  it("keyword 记录整条阶梯，不冒充单个关键词", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["孤独摇滚", "孤独摇滚 2022", "Bocchi the Rock!"],
      snapshots: [snapshot("s1", "孤独摇滚", [candidate("c1", "s1")])],
      createdAt: CREATED_AT,
    });
    expect(merged.keyword).toBe("孤独摇滚 | 孤独摇滚 2022 | Bocchi the Rock!");
  });

  it("保留 providerPayload（这正是 import 要取回的东西）", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["a"],
      snapshots: [snapshot("s1", "a", [candidate("c1", "s1")])],
      createdAt: CREATED_AT,
    });
    expect(merged.candidates[0]!.providerPayload).toEqual({ url: "https://115.com/s/c1", password: "p" });
  });

  it("空输入 ⇒ 空候选，不抛", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: [],
      snapshots: [],
      createdAt: CREATED_AT,
    });
    expect(merged.candidates).toEqual([]);
    expect(merged.keyword).toBe("");
  });

  it("**合并快照可直接用于 import 校验**（第一条 keyword 找到的候选也认）", () => {
    const merged = buildMergedSearchSnapshot({
      id: "merged-1",
      provider: "pansou",
      keywords: ["孤独摇滚", "Bocchi the Rock!"],
      snapshots: [
        snapshot("s1", "孤独摇滚", [candidate("c1", "s1")]),
        snapshot("s2", "Bocchi the Rock!", [candidate("c2", "s2")]),
      ],
      createdAt: CREATED_AT,
    });
    // 用户从合并视图里点了 c2（它原本属于 s2），import 必须认
    const resolved = resolveManualImportCandidate({
      snapshot: merged,
      candidateId: "c2",
      now: Date.parse(CREATED_AT) + 1000,
    });
    expect(resolved.kind).toBe("ok");
  });
});
