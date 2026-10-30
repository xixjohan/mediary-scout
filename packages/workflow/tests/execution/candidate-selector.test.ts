import { describe, expect, it } from "vitest";
import type { ResourceCandidate, ResourceSnapshot } from "../../src/domain.js";
import {
  HumanCandidateSelector,
  decisionFromSelection,
  type CandidateSelection,
  type CandidateSelector,
} from "../../src/candidate-selector.js";

/**
 * 批次 3 第四项：CandidateSelector 端口 + agent/human 两实现。
 *
 * 核心验收是「手动与自动两条路径产出的 AgentDecision 结构一致」。这里的关键不是两条
 * 路径各自正确，而是它们**收敛到同一个构造函数**——否则「结构一致」只是一句愿望。
 */

function candidate(id: string, snapshotId = "snap-1"): ResourceCandidate {
  return {
    id,
    snapshotId,
    index: 0,
    title: "孤独摇滚 S01E01",
    type: "115",
    source: "pansou-115",
    providerPayload: { url: "https://115.com/s/x", password: "p" },
  };
}

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    id: "snap-1",
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt: "2024-05-01T10:00:00Z",
    candidates: [candidate("c1"), candidate("c2"), candidate("c3")],
    ...overrides,
  };
}

/** agent 侧选择器的最小实现：按标题排序取第一个（真实实现用模型，这里只验形状）。 */
class FakeAgentSelector implements CandidateSelector {
  readonly source = "agent" as const;
  select(input: { snapshot: ResourceSnapshot }): CandidateSelection {
    const first = input.snapshot.candidates[0];
    return {
      selectedCandidateIds: first ? [first.id] : [],
      confidence: "high",
      reason: "agent 判定首选",
    };
  }
}

describe("HumanCandidateSelector", () => {
  it("source 是 human", () => {
    expect(new HumanCandidateSelector("c1").source).toBe("human");
  });

  it("选中用户点的那一个，confidence=high（人亲眼看过那一行）", () => {
    const selection = new HumanCandidateSelector("c2").select({ snapshot: snapshot() });
    expect(selection.selectedCandidateIds).toEqual(["c2"]);
    expect(selection.confidence).toBe("high");
    expect(selection.reason).toContain("孤独摇滚 S01E01");
  });

  it("candidateId 不属于该快照 ⇒ 空选择（不把调用方喂的任何 id 回声出去）", () => {
    const selection = new HumanCandidateSelector("nope").select({ snapshot: snapshot() });
    expect(selection.selectedCandidateIds).toEqual([]);
  });

  it("candidateId 属于**别的**快照 ⇒ 空选择", () => {
    const snap = snapshot({ candidates: [candidate("c1", "snap-OTHER")] });
    expect(new HumanCandidateSelector("c1").select({ snapshot: snap }).selectedCandidateIds).toEqual([]);
  });
});

describe("decisionFromSelection — 两条路径收敛到同一形状", () => {
  it("agent 与 human 的**结构**一致：同键、同类型，只有 source 是判别字段", () => {
    // 注意：不是值一致。reason 记的是「谁选的、为什么」，本就**应该**不同——把它
    // 一起断言成相同，是在要求两条路径说同一句话，那不是「结构一致」。
    const snap = snapshot();
    const agentSelection: CandidateSelection = {
      selectedCandidateIds: ["c1"],
      confidence: "high",
      reason: "agent 判定首选",
    };
    const humanSelection = new HumanCandidateSelector("c1").select({ snapshot: snap });

    const agentDecision = decisionFromSelection({
      selection: agentSelection,
      snapshot: snap,
      source: "agent",
      node: "acquisition_v2_sandbox_agent",
    });
    const humanDecision = decisionFromSelection({
      selection: humanSelection,
      snapshot: snap,
      source: "human",
      node: "manual_import",
    });

    // 形状 = 每个字段的类型签名。同键同类型才算结构一致。
    const shapeOf = (value: unknown): string =>
      Array.isArray(value)
        ? `array`
        : value === null
          ? `null`
          : typeof value === "object"
            ? `object`
            : typeof value;
    const agentShape = Object.fromEntries(
      Object.entries(agentDecision).map(([key, value]) => [key, shapeOf(value)]),
    );
    const humanShape = Object.fromEntries(
      Object.entries(humanDecision).map(([key, value]) => [key, shapeOf(value)]),
    );
    expect(humanShape).toEqual(agentShape);

    expect(agentDecision.source).toBe("agent");
    expect(humanDecision.source).toBe("human");
    // 判别字段只有 source；node 也允许不同（两条路径的节点名本就不同）
    expect(humanDecision.selectedCandidateIds).toEqual(agentDecision.selectedCandidateIds);
    expect(humanDecision.confidence).toBe(agentDecision.confidence);
    expect(humanDecision.snapshotId).toBe(agentDecision.snapshotId);
    // reason 内容不同，但都是非空字符串
    expect(humanDecision.reason).not.toBe(agentDecision.reason);
    expect(typeof humanDecision.reason).toBe("string");
    expect(humanDecision.reason.length).toBeGreaterThan(0);
  });

  it("键集合封闭（不允许某一侧多出字段）", () => {
    const decision = decisionFromSelection({
      selection: { selectedCandidateIds: ["c1"], confidence: "high", reason: "r" },
      snapshot: snapshot(),
      source: "human",
      node: "manual_import",
    });
    expect(Object.keys(decision).sort()).toEqual([
      "confidence",
      "episodeMapping",
      "node",
      "providerAheadEpisodeMapping",
      "reason",
      "rejectedCandidateIds",
      "selectedCandidateIds",
      "snapshotId",
      "source",
    ]);
  });

  it("reason 截到 2000 字符（与库里 agent 路径同一上限）", () => {
    const decision = decisionFromSelection({
      selection: { selectedCandidateIds: ["c1"], confidence: "high", reason: "x".repeat(5000) },
      snapshot: snapshot(),
      source: "human",
      node: "manual_import",
    });
    expect(decision.reason).toHaveLength(2000);
  });

  it("rejectedCandidateIds 可传，缺省为空数组（不留 undefined）", () => {
    const base = {
      selection: { selectedCandidateIds: ["c1"] as string[], confidence: "high" as const, reason: "r" },
      snapshot: snapshot(),
      source: "human" as const,
      node: "manual_import",
    };
    expect(decisionFromSelection(base).rejectedCandidateIds).toEqual([]);
    expect(decisionFromSelection({ ...base, rejectedCandidateIds: ["c2", "c3"] }).rejectedCandidateIds).toEqual([
      "c2",
      "c3",
    ]);
  });

  it("selectedCandidateIds 是副本（改决策不改选择结果）", () => {
    const selection: CandidateSelection = { selectedCandidateIds: ["c1"], confidence: "high", reason: "r" };
    const decision = decisionFromSelection({ selection, snapshot: snapshot(), source: "human", node: "n" });
    decision.selectedCandidateIds.push("c2");
    expect(selection.selectedCandidateIds).toEqual(["c1"]);
  });
});
