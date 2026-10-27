import { describe, expect, it } from "vitest";
import type { ResourceCandidate, ResourceSnapshot } from "../src/domain.js";
import {
  MANUAL_IMPORT_TTL_MS,
  manualImportRemainingMs,
  resolveManualImportCandidate,
} from "../src/manual-import-resolver.js";

/**
 * 批次 3 的核心校验。plan 的验收第一条就是「candidateId 不属于该 snapshot → 拒绝」，
 * 第二条是「超 30 分钟 → 拒绝」。
 *
 * 为什么不用 CandidateRegistry（进程内 Map）取 payload：它随进程消亡，且只按
 * candidateId 单键索引，答不出「这个候选属于这份快照吗」——而那正是 plan 要求的校验。
 */

const CREATED_AT = "2024-05-01T10:00:00Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

function candidate(id: string, snapshotId = "snap-1"): ResourceCandidate {
  return {
    id,
    snapshotId,
    index: 0,
    title: "孤独摇滚 S01E01",
    type: "115",
    source: "pansou-115",
    // payload 正是不能下前端的东西
    providerPayload: { url: "https://115.com/s/swxy8ab", password: "a1b2" },
  };
}

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    id: "snap-1",
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt: CREATED_AT,
    candidates: [candidate("c1"), candidate("c2")],
    ...overrides,
  };
}

const NOW = CREATED_AT_MS + 5 * 60 * 1000; // 5 分钟后

describe("resolveManualImportCandidate — 归属校验（验收第一条）", () => {
  it("candidateId 属于该 snapshot ⇒ ok，且带回 payload", () => {
    const result = resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "c1", now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.candidate.id).toBe("c1");
    expect(result.candidate.providerPayload).toEqual({ url: "https://115.com/s/swxy8ab", password: "a1b2" });
  });

  it("candidateId 不在候选列表 ⇒ not_found", () => {
    const result = resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "nope", now: NOW });
    expect(result.kind).toBe("not_found");
  });

  it("candidateId 属于**别的** snapshot ⇒ not_found（防跨快照套用）", () => {
    // 同 id 不同 snapshotId：只比 id 会误放行
    const snap = snapshot({ candidates: [candidate("c1", "snap-OTHER")] });
    const result = resolveManualImportCandidate({ snapshot: snap, candidateId: "c1", now: NOW });
    expect(result.kind).toBe("not_found");
  });

  it("快照自身的 id 与候选的 snapshotId 不一致 ⇒ not_found", () => {
    const snap = snapshot({ id: "snap-1", candidates: [candidate("c1", "snap-2")] });
    expect(resolveManualImportCandidate({ snapshot: snap, candidateId: "c1", now: NOW }).kind).toBe("not_found");
  });

  it("空 candidateId ⇒ not_found", () => {
    expect(resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "", now: NOW }).kind).toBe("not_found");
  });
});

describe("resolveManualImportCandidate — TTL（验收第二条）", () => {
  it("恰好 30 分钟 ⇒ 仍可导入（边界含在内）", () => {
    const atBoundary = CREATED_AT_MS + MANUAL_IMPORT_TTL_MS;
    expect(resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "c1", now: atBoundary }).kind).toBe("ok");
  });

  it("超过 30 分钟 ⇒ expired，且报出年龄", () => {
    const tooLate = CREATED_AT_MS + MANUAL_IMPORT_TTL_MS + 1;
    const result = resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "c1", now: tooLate });
    expect(result.kind).toBe("expired");
    if (result.kind !== "expired") return;
    expect(result.ageMs).toBe(MANUAL_IMPORT_TTL_MS + 1);
  });

  it("clock 早于 createdAt（时钟回拨）不误判为过期", () => {
    // ageMs 为负 ⇒ 不超 TTL。不要把未来时间戳当成过期。
    const result = resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "c1", now: CREATED_AT_MS - 60_000 });
    expect(result.kind).toBe("ok");
  });

  it("ttlMs 可覆盖（测试注入小窗口）", () => {
    const result = resolveManualImportCandidate({
      snapshot: snapshot(),
      candidateId: "c1",
      now: CREATED_AT_MS + 1001,
      ttlMs: 1000,
    });
    expect(result.kind).toBe("expired");
  });
});

describe("resolveManualImportCandidate — 判定顺序", () => {
  it("既不属于又已过期 ⇒ not_found（归属优先，错误信息才对得上）", () => {
    const tooLate = CREATED_AT_MS + MANUAL_IMPORT_TTL_MS + 1;
    const result = resolveManualImportCandidate({ snapshot: snapshot(), candidateId: "nope", now: tooLate });
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveManualImportCandidate — 快照本身不合法", () => {
  it("无 id ⇒ invalid_snapshot", () => {
    const result = resolveManualImportCandidate({
      snapshot: snapshot({ id: "" }),
      candidateId: "c1",
      now: NOW,
    });
    expect(result.kind).toBe("invalid_snapshot");
  });

  it("无候选列表 ⇒ invalid_snapshot", () => {
    const broken = snapshot();
    // @ts-expect-error — 故意构造坏数据
    broken.candidates = undefined;
    expect(resolveManualImportCandidate({ snapshot: broken, candidateId: "c1", now: NOW }).kind).toBe(
      "invalid_snapshot",
    );
  });

  it("createdAt 不是时间戳 ⇒ invalid_snapshot", () => {
    const result = resolveManualImportCandidate({
      snapshot: snapshot({ createdAt: "not-a-date" }),
      candidateId: "c1",
      now: NOW,
    });
    expect(result.kind).toBe("invalid_snapshot");
  });
});

describe("manualImportRemainingMs", () => {
  it("给剩余可导入时间", () => {
    expect(manualImportRemainingMs(snapshot(), NOW)).toBe(MANUAL_IMPORT_TTL_MS - 5 * 60 * 1000);
  });

  it("过期后为负", () => {
    expect(manualImportRemainingMs(snapshot(), CREATED_AT_MS + MANUAL_IMPORT_TTL_MS + 5000)).toBe(-5000);
  });

  it("时间戳不可解析时返回 null（不渲染一个假的倒计时）", () => {
    expect(manualImportRemainingMs(snapshot({ createdAt: "x" }), NOW)).toBeNull();
  });
});
