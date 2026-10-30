import { describe, expect, it } from "vitest";
import type { AuditEvent, VerifiedFile } from "../../src/domain.js";
import type { StorageExecutor } from "../../src/ports.js";
import {
  executeOrganizePlan,
  organizeDriftCopy,
  organizeRunStatus,
  plannedMovesFromRun,
  recordOrganizeDrift,
  recordPlannedMoves,
} from "../../src/organize-executor.js";
import { planOrganizeMoves, type OrganizeInputFile, type OrganizeMove } from "../../src/organize-plan.js";

/**
 * Batch 4 的执行半边 + 护栏的另一面。
 *
 * 核心断言是**顺序**：planned moves 必须在第一次 moveFiles 之前落库。一个跑到一半
 * 崩掉的 run 必须留下它想干什么，否则重启后的比对没有对照物——而那正是护栏存在的
 * 全部理由。
 */

function file(fileName: string, fileId = fileName): OrganizeInputFile {
  return { fileId, fileName };
}

function fakeStorage(
  filesByDir: Record<string, VerifiedFile[]>,
  overrides: Partial<StorageExecutor> = {},
): StorageExecutor {
  const calls: string[] = [];
  return {
    createDirectory: async ({ name }) => {
      calls.push(`mkdir:${name}`);
      return `dir_${name}`;
    },
    listVideoFiles: async (directoryId) => {
      calls.push(`list:${directoryId}`);
      return filesByDir[directoryId] ?? [];
    },
    listUnparsedVideoFiles: async () => [],
    renameFile: async () => {},
    moveFiles: async ({ fileIds, targetDirectoryId }) => {
      calls.push(`move:${fileIds.join(",")}->${targetDirectoryId}`);
      return { moved: [...fileIds] };
    },
    transfer: async () => {
      throw new Error("not used");
    },
    flattenDirectory: async () => ({ moved: [], removed: [] }),
    deleteFiles: async () => ({ deleted: [] }),
    removeDirectory: async () => ({ removed: true }),
    snapshotStagingDirectory: async () => ({ files: [] }),
    listChildDirectories: async () => [],
    ...overrides,
  } as StorageExecutor;
}

function verified(id: string, name: string, directoryId: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: directoryId,
    name,
    sizeBytes: 1,
    episodeCode: "S01E01",
    providerFileId: id,
  };
}

function deterministicPlan(targetDir = "dir_season_01"): {
  moves: OrganizeMove[];
  plan: ReturnType<typeof planOrganizeMoves>;
} {
  const plan = planOrganizeMoves({
    files: [file("Show S01E01.mkv", "f1"), file("Show S01E02.mkv", "f2")],
    targetSeasons: [1],
    resolveTargetDirectory: () => targetDir,
  });
  if (plan.kind !== "deterministic") throw new Error("fixture");
  return { moves: plan.moves, plan };
}

/** 落库的事件序列 + 可查询。 */
function recorder(): { events: AuditEvent[]; persist: (event: AuditEvent) => Promise<void> } {
  const events: AuditEvent[] = [];
  return { events, persist: async (event) => void events.push(event) };
}

describe("executeOrganizePlan — 护栏顺序", () => {
  it("**planned moves 在第一次 moveFiles 之前落库**", async () => {
    const order: string[] = [];
    const { plan } = deterministicPlan();
    const storage = fakeStorage(
      { dir_season_01: [verified("f1", "Show S01E01.mkv", "dir_season_01"), verified("f2", "Show S01E02.mkv", "dir_season_01")] },
      {
        moveFiles: async (input) => {
          order.push(`move:${input.fileIds[0]}`);
          return { moved: [...input.fileIds] };
        },
      },
    );
    const rec = recorder();
    const originalPersist = rec.persist;
    const persisting = async (event: AuditEvent) => {
      order.push(`persist:${event.type}`);
      await originalPersist(event);
    };

    await executeOrganizePlan({ storage, plan, persist: persisting });

    expect(order[0]).toBe("persist:organize_planned_moves");
    expect(order.indexOf("persist:organize_planned_moves")).toBeLessThan(order.indexOf("move:f1"));
  });

  it("一次搬一个文件（半成功的批量调用给不出逐文件答案）", async () => {
    const seen: string[][] = [];
    const { plan } = deterministicPlan();
    const storage = fakeStorage(
      { dir_season_01: [verified("f1", "a", "dir_season_01"), verified("f2", "b", "dir_season_01")] },
      {
        moveFiles: async (input) => {
          seen.push([...input.fileIds]);
          return { moved: [...input.fileIds] };
        },
      },
    );
    await executeOrganizePlan({ storage, plan, persist: recorder().persist });
    expect(seen).toEqual([["f1"], ["f2"]]);
  });

  it("全部落位 ⇒ organized，且没有再写 drift 事件", async () => {
    const { plan, moves } = deterministicPlan();
    const storage = fakeStorage({
      dir_season_01: [verified("f1", "a", "dir_season_01"), verified("f2", "b", "dir_season_01")],
    });
    const rec = recorder();
    const result = await executeOrganizePlan({ storage, plan, persist: rec.persist });
    expect(result.status).toBe("organized");
    if (result.status !== "organized") return;
    expect(result.moves).toEqual(moves);
    expect(rec.events.map((e) => e.type)).toEqual(["organize_planned_moves"]);
  });
});

describe("executeOrganizePlan — manual_review 不碰盘", () => {
  it("**一个文件都不搬**，也不写 planned 事件", async () => {
    const plan = planOrganizeMoves({
      files: [file("Show S01E01.mkv", "f1"), file("random.mp4", "f2")],
      targetSeasons: [1],
      resolveTargetDirectory: () => "dir_season_01",
    });
    expect(plan.kind).toBe("manual_review");
    let moved = false;
    const storage = fakeStorage({}, {
      moveFiles: async (input) => {
        moved = true;
        return { moved: [...input.fileIds] };
      },
    });
    const rec = recorder();
    const result = await executeOrganizePlan({ storage, plan, persist: rec.persist });
    expect(result.status).toBe("manual_review");
    if (result.status !== "manual_review") return;
    expect(result.unresolvedCount).toBe(1);
    expect(moved).toBe(false);
    expect(rec.events).toEqual([]);
  });
});

describe("executeOrganizePlan — ③ 偏差即停", () => {
  it("有文件没搬过去 ⇒ drift(missing)，写 drift 事件，**不重试**", async () => {
    const { plan } = deterministicPlan();
    const attempts: string[] = [];
    const storage = fakeStorage(
      { dir_season_01: [verified("f1", "a", "dir_season_01")] }, // f2 不在
      {
        moveFiles: async (input) => {
          attempts.push(input.fileIds.join(","));
          return { moved: [...input.fileIds] };
        },
      },
    );
    const rec = recorder();
    const result = await executeOrganizePlan({ storage, plan, persist: rec.persist });
    expect(result.status).toBe("drift");
    if (result.status !== "drift") return;
    expect(result.drift.kind).toBe("missing");
    // 每个文件只搬一次：对一次没按计划落地的盘重试，正是把半搬的包搬两遍的来路
    expect(attempts).toEqual(["f1", "f2"]);
    expect(rec.events.map((e) => e.type)).toEqual(["organize_planned_moves", "organize_drift"]);
  });

  it("搬到另一个**计划内**目录 ⇒ drift(wrong_target)", async () => {
    // 读回只列计划内的目录（盘是权威，但逐一搜全盘太贵）。所以 wrong_target 能检出的
    // 是「落到另一个计划目录」——S01 的文件落进 S02 的目录，正是现实中最容易发生、
    // 也最该被抓住的那一种。
    const plan = planOrganizeMoves({
      files: [file("Show S01E01.mkv", "f1"), file("Show S02E01.mkv", "f2")],
      targetSeasons: [1, 2],
      resolveTargetDirectory: (season) => `dir_season_0${season}`,
    });
    const storage = fakeStorage({
      dir_season_01: [],
      // f1 落进了第 2 季的目录
      dir_season_02: [verified("f1", "a", "dir_season_02"), verified("f2", "b", "dir_season_02")],
    });
    const result = await executeOrganizePlan({ storage, plan, persist: recorder().persist });
    expect(result.status).toBe("drift");
    if (result.status !== "drift") return;
    expect(result.drift.kind).toBe("wrong_target");
    if (result.drift.kind !== "wrong_target") return;
    expect(result.drift.moves[0]!.move.fileId).toBe("f1");
    expect(result.drift.moves[0]!.actualDirectoryId).toBe("dir_season_02");
  });

  it("**落到计划外的目录 ⇒ 报 missing**（仍然是偏差，仍然停）", async () => {
    // 这是诚实的边界：读回只列计划内目录，所以「跑到完全另一个地方」表现为 missing
    // 而不是 wrong_target。都是停 + 报人工，只是诊断词不同。
    const { plan } = deterministicPlan();
    const storage = fakeStorage({ dir_season_01: [] });
    const result = await executeOrganizePlan({ storage, plan, persist: recorder().persist });
    expect(result.status).toBe("drift");
    if (result.status !== "drift") return;
    expect(result.drift.kind).toBe("missing");
  });

  it("读回时盘抛错 ⇒ failed（不是 organized）", async () => {
    const { plan } = deterministicPlan();
    const storage = fakeStorage({}, {
      listVideoFiles: async () => {
        throw new Error("drive gone");
      },
    });
    const result = await executeOrganizePlan({ storage, plan, persist: recorder().persist });
    expect(result.status).toBe("failed");
  });

  it("比对用盘上真实身份（file.id），不用文件名", async () => {
    // 文件名会在后续规范化步骤里变；若按名字比对，规范化之后就会误报 drift。
    const { plan } = deterministicPlan();
    const storage = fakeStorage({
      dir_season_01: [
        verified("f1", "已规范化的名字.mkv", "dir_season_01"),
        verified("f2", "另一个名字.mkv", "dir_season_01"),
      ],
    });
    const result = await executeOrganizePlan({ storage, plan, persist: recorder().persist });
    expect(result.status).toBe("organized");
  });
});

describe("plannedMovesFromRun — 跨 SQLite 边界读回", () => {
  it("写进去的能原样读回", () => {
    const { moves } = deterministicPlan();
    const events = [recordPlannedMoves(moves)];
    expect(plannedMovesFromRun(events)).toEqual(moves);
  });

  it("没有计划事件 ⇒ 空数组（不是抛错）", () => {
    expect(plannedMovesFromRun([])).toEqual([]);
    expect(plannedMovesFromRun([{ type: "something_else", message: "x" }])).toEqual([]);
  });

  it("**计划有洞 ⇒ 整体作废**，不执行能解析的那部分", () => {
    const { moves } = deterministicPlan();
    const events = recordPlannedMoves(moves);
    const data = events.data as { moves: Record<string, unknown>[] };
    delete data.moves[1]!["targetDirectoryId"];
    expect(plannedMovesFromRun([events])).toEqual([]);
  });

  it("取最后一个计划事件（重试会追加新的）", () => {
    const { moves } = deterministicPlan();
    const first = recordPlannedMoves(moves);
    const second = recordPlannedMoves([{ ...moves[0]!, targetDirectoryId: "dir_v2" }]);
    expect(plannedMovesFromRun([first, second])[0]!.targetDirectoryId).toBe("dir_v2");
  });
});

describe("organizeDriftCopy — 给要去修盘的人看的话", () => {
  it("missing 点名是哪些文件", () => {
    const { moves } = deterministicPlan();
    const copy = organizeDriftCopy({ kind: "missing", moves: [moves[1]!] });
    expect(copy).toContain("Show S01E02.mkv");
    expect(copy).toContain("整理中断");
  });

  it("wrong_target 说明放错了位置", () => {
    const { moves } = deterministicPlan();
    const copy = organizeDriftCopy({
      kind: "wrong_target",
      moves: [{ move: moves[0]!, actualDirectoryId: "dir_season_02" }],
    });
    expect(copy).toContain("放错位置");
  });

  it("match 不谎报问题", () => {
    expect(organizeDriftCopy({ kind: "match" })).toContain("一致");
  });
});

describe("organizeRunStatus", () => {
  it("三种终局各自映射", () => {
    expect(organizeRunStatus({ status: "organized", moves: [] })).toBe("succeeded");
    expect(organizeRunStatus({ status: "manual_review", unresolvedCount: 1 })).toBe("manual_review");
    expect(organizeRunStatus({ status: "drift", drift: { kind: "match" } })).toBe("failed");
    expect(organizeRunStatus({ status: "failed", error: "x" })).toBe("failed");
  });
});
