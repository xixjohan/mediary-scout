import { describe, expect, it } from "vitest";
import type { MediaTitle, ResourceCandidate, ResourceSnapshot, TrackedSeason } from "../src/domain.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { MANUAL_IMPORT_KIND, buildManualImportReservation, queueManualImport } from "../src/manual-import-command.js";
import { MANUAL_IMPORT_TTL_MS } from "../src/manual-import-resolver.js";

/**
 * 批次 3 ①：手动入库的排队命令。
 *
 * 断言的要点：**候选归属在命令层被校验，而不是信任调用方**；以及持久化的 decision 与
 * agent 路径结构一致（plan 批次 3 验收第四条）。
 */

const CREATED_AT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

function title(): MediaTitle {
  return {
    id: "t1",
    tmdbId: 283428,
    type: "tv",
    title: "孤独摇滚",
    originalTitle: "Bocchi the Rock!",
    year: 2022,
    aliases: [],
  };
}

function season(): TrackedSeason {
  return {
    id: "t1_s1",
    mediaTitleId: "t1",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
  };
}

function candidate(id: string): ResourceCandidate {
  return {
    id,
    snapshotId: "snap-1",
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
    createdAt: CREATED_AT,
    candidates: [candidate("c1"), candidate("c2")],
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof queueManualImport>[0]["request"]> = {}) {
  return {
    snapshot: snapshot(),
    candidateId: "c1",
    title: title(),
    season: season(),
    accountId: "acct_default",
    ...overrides,
  };
}

describe("queueManualImport — 放行", () => {
  it("合法候选 ⇒ queued，并落一条 manual_import run", async () => {
    const repo = new InMemoryWorkflowRepository();
    const result = await queueManualImport({ request: request(), repository: repo });
    expect(result.status).toBe("queued");
    if (result.status !== "queued") return;
    expect(result.workflowRunId).toBeTruthy();

    const saved = await repo.getWorkflowRunSnapshot(result.workflowRunId, "acct_default");
    expect(saved).not.toBeNull();
    expect(saved!.workflowRun.kind).toBe(MANUAL_IMPORT_KIND);
    expect(saved!.workflowRun.status).toBe("queued");
  });

  it("快照随 run 一起落库（worker 之后要按 candidateId 取回 payload）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const result = await queueManualImport({ request: request(), repository: repo });
    if (result.status !== "queued") throw new Error("unexpected");
    const saved = await repo.getWorkflowRunSnapshot(result.workflowRunId, "acct_default");
    expect(saved!.resourceSnapshots).toHaveLength(1);
    expect(saved!.resourceSnapshots[0]!.id).toBe("snap-1");
    expect(saved!.resourceSnapshots[0]!.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("decision 落库且 source=human（与 agent 路径只差这个字段）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const result = await queueManualImport({ request: request(), repository: repo });
    if (result.status !== "queued") throw new Error("unexpected");
    const saved = await repo.getWorkflowRunSnapshot(result.workflowRunId, "acct_default");
    expect(saved!.decisions).toHaveLength(1);
    expect(saved!.decisions[0]!.source).toBe("human");
    expect(saved!.decisions[0]!.selectedCandidateIds).toEqual(["c1"]);
    expect(saved!.decisions[0]!.snapshotId).toBe("snap-1");
  });

  it("**候选归属在命令层被校验**，不信任调用方", async () => {
    const repo = new InMemoryWorkflowRepository();
    const result = await queueManualImport({ request: request({ candidateId: "nope" }), repository: repo });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("not_found");
    expect(result.copy).toContain("重新查询");
    // 没有落任何 run
    expect((await repo.getWorkflowRunSnapshot("anything", "acct_default"))).toBeNull();
  });

  it("超过 TTL ⇒ expired", async () => {
    const repo = new InMemoryWorkflowRepository();
    const stale = snapshot({ createdAt: new Date(Date.now() - MANUAL_IMPORT_TTL_MS - 60_000).toISOString() });
    const result = await queueManualImport({ request: request({ snapshot: stale }), repository: repo });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("expired");
  });
});

describe("buildManualImportReservation — 载荷形状", () => {
  it("键集合封闭：没有任何让调用方挑盘的字段（plan §3.2）", () => {
    const reservation = buildManualImportReservation({
      request: request(),
      snapshot: snapshot(),
      selection: { selectedCandidateIds: ["c1"], confidence: "high", reason: "用户手动选择" },
      workflowRunId: "run-1",
      queuedAt: CREATED_AT,
    });
    expect(Object.keys(reservation).sort()).toEqual([
      "accountId",
      "blockIfTitleHasActiveRun",
      "decisions",
      "episodes",
      "notifications",
      "resourceSnapshots",
      "season",
      "title",
      "transferAttempts",
      "workflowRun",
    ]);
    // 没有 drive / storageId / targetDrive 之类的挑盘字段
    for (const key of Object.keys(reservation)) {
      expect(key.toLowerCase()).not.toContain("drive");
      expect(key.toLowerCase()).not.toContain("target");
    }
  });

  it("drive scope 跟随传入值（省略则不写，交给仓储默认）", () => {
    const base = {
      snapshot: snapshot(),
      selection: { selectedCandidateIds: ["c1"] as string[], confidence: "high" as const, reason: "r" },
      workflowRunId: "run-1",
      queuedAt: CREATED_AT,
    };
    expect(buildManualImportReservation({ ...base, request: request({ connectedStorageId: "drive_1" }) }).connectedStorageId).toBe("drive_1");
    expect(buildManualImportReservation({ ...base, request: request() }).connectedStorageId).toBeUndefined();
  });

  it("blockIfTitleHasActiveRun 为 true（两个导入并发会抢 staging）", () => {
    const reservation = buildManualImportReservation({
      request: request(),
      snapshot: snapshot(),
      selection: { selectedCandidateIds: ["c1"], confidence: "high", reason: "r" },
      workflowRunId: "run-1",
      queuedAt: CREATED_AT,
    });
    expect(reservation.blockIfTitleHasActiveRun).toBe(true);
  });
});
