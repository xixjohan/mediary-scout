import { describe, expect, it } from "vitest";
import type { MediaTitle, ResourceSnapshot, TransferAttempt } from "../../src/domain.js";
import type { StorageExecutor } from "../../src/domain/ports.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { runQueuedOwnerIngest } from "../../src/execution/owner-ingest-worker.js";
import { MANUAL_IMPORT_TTL_MS } from "../../src/execution/manual-import-resolver.js";

/**
 * owner_ingest worker 的「不可滞留」契约（与 manual-import-worker 同源）：
 * 任何一个分支都必须把 run 落成终态——`queued` 计为 active 且投放带
 * `blockIfTitleHasActiveRun`，滞留的 run 会把该标题的后续工作全堵死。
 *
 * 另外两条只属于投放的断言：
 *  - **目标目录来自 run 记录**（审计事件），不是外部参数；
 *  - **落盘失败（含 accepted_pending）不得判成功**——提交 ≠ 入库。
 */

const NOW = "2026-11-17T00:05:00.000Z";

function title(): MediaTitle {
  return {
    id: "owner_ingest_drive_1_kw",
    tmdbId: 0,
    type: "movie",
    title: "kw",
    originalTitle: "kw",
    year: 0,
    aliases: [],
  };
}

function snapshot(): ResourceSnapshot {
  return {
    id: "snap_owner",
    provider: "pansou",
    keyword: "kw",
    createdAt: "2026-11-17T00:00:00.000Z",
    candidates: [
      {
        id: "c1",
        snapshotId: "snap_owner",
        index: 0,
        title: "kw magnet",
        type: "magnet",
        source: "pansou-magnet",
        providerPayload: { url: "magnet:?xt=urn:btih:abc" },
      },
    ],
  };
}

function fakeStorage(overrides: Partial<StorageExecutor> = {}): StorageExecutor {
  const base: StorageExecutor = {
    createDirectory: async ({ name }) => `dir_${name}`,
    listVideoFiles: async () => [],
    listUnparsedVideoFiles: async () => [],
    renameFile: async () => {},
    transfer: async (input): Promise<TransferAttempt> => ({
      id: "att1",
      workflowRunId: input.workflowRunId,
      candidateId: "c1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["f1"],
    }),
    flattenDirectory: async () => ({ moved: [], removed: [] }),
    deleteFiles: async () => ({ deleted: [] }),
    removeDirectory: async () => ({ removed: true }),
    listChildDirectories: async () => [],
    listTree: async () => [],
    listSubdirectories: async () => [],
    moveFiles: async () => ({ moved: [] }),
  };
  return { ...base, ...overrides } as StorageExecutor;
}

async function seedRun(
  repo: InMemoryWorkflowRepository,
  opts: { targetDirectoryId: string; createdAt?: string; status?: "queued" | "running" } = { targetDirectoryId: "dir_x" },
): Promise<string> {
  const runId = `oi_${Math.random().toString(36).slice(2, 8)}`;
  const snap = { ...snapshot(), createdAt: opts.createdAt ?? "2026-11-17T00:00:00.000Z" };
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct_default",
    connectedStorageId: "drive_1",
    title: title(),
    season: {
      id: "owner_ingest_drive_1_kw_s1",
      mediaTitleId: "owner_ingest_drive_1_kw",
      seasonNumber: 1,
      status: "completed",
      qualityPreference: "4K",
      storageDirectoryId: opts.targetDirectoryId,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "manual",
    },
    workflowRun: {
      id: runId,
      kind: "owner_ingest",
      status: opts.status ?? "queued",
      trackedSeasonId: "owner_ingest_drive_1_kw_s1",
      startedAt: opts.createdAt ?? "2026-11-17T00:00:00.000Z",
      finishedAt: null,
      auditEvents: [
        {
          type: "owner_ingest_queued",
          message: "queued",
          data: { candidateId: "c1", targetDirectoryId: opts.targetDirectoryId, boundTitle: false },
        },
      ],
    },
    episodes: [],
    resourceSnapshots: [snap],
    decisions: [
      {
        node: "owner_ingest",
        snapshotId: snap.id,
        source: "human",
        selectedCandidateIds: ["c1"],
        episodeMapping: {},
        providerAheadEpisodeMapping: {},
        rejectedCandidateIds: [],
        confidence: "high",
        reason: "operator selected",
      },
    ],
    transferAttempts: [],
    notifications: [],
  });
  return runId;
}

describe("runQueuedOwnerIngest", () => {
  it("成功路径：转存成功 → 终态 succeeded，并记录落盘文件数", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedRun(repo, { targetDirectoryId: "dir_target" });
    let transferredTo: string | null = null;
    const result = await runQueuedOwnerIngest({
      repository: repo,
      storage: fakeStorage({
        transfer: async (input) => {
          transferredTo = input.directoryId;
          return {
            id: "att1",
            workflowRunId: input.workflowRunId,
            candidateId: "c1",
            status: "succeeded",
            providerMessage: "",
            materializedFileIds: ["f1", "f2"],
          };
        },
      }),
      now: () => NOW,
    });

    expect(result.status).toBe("succeeded");
    // 目标目录必须来自 run 记录里的审计事件（不是 query 参数）。
    expect(transferredTo).toBe("dir_target");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("succeeded");
    const landed = saved!.workflowRun.auditEvents.find((e) => e.type === "owner_ingest_landed");
    expect(landed?.data?.["fileCount"]).toBe(2);
  });

  it("**转存前先授权用户选的目录**（影视库外的投放不再被 WRITE_SCOPE_VIOLATION 误拒）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedRun(repo, { targetDirectoryId: "outside_library" });
    const authorized: string[] = [];
    const order: string[] = [];
    const result = await runQueuedOwnerIngest({
      repository: repo,
      storage: {
        ...fakeStorage({
          transfer: async (input) => {
            order.push("transfer");
            return {
              id: "att1",
              workflowRunId: input.workflowRunId,
              candidateId: "c1",
              status: "succeeded",
              providerMessage: "",
              materializedFileIds: ["f1"],
            };
          },
        }),
        authorizeWriteTarget: (directoryId: string) => {
          authorized.push(directoryId);
          order.push("authorize");
        },
      },
      now: () => NOW,
    });

    expect(result.status).toBe("succeeded");
    // 授权必须发生在转存之前，且用的就是 run 里记录的目标目录。
    expect(order).toEqual(["authorize", "transfer"]);
    expect(authorized).toEqual(["outside_library"]);
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("succeeded");
  });

  it("**转存未落盘（accepted_pending）→ failed，不得算入库**", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedRun(repo, { targetDirectoryId: "dir_target" });
    const result = await runQueuedOwnerIngest({
      repository: repo,
      storage: fakeStorage({
        transfer: async (input) => ({
          id: "att1",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "failed",
          providerMessage: "磁力已受理但尚未落盘",
          materializedFileIds: [],
          outcome: "accepted_pending",
        }),
      }),
      now: () => NOW,
    });
    expect(result.status).toBe("failed");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });

  it("超过 30 分钟窗口 → rejected（终态，不滞留 queued）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const staleAt = new Date(Date.parse(NOW) - MANUAL_IMPORT_TTL_MS - 60_000).toISOString();
    const runId = await seedRun(repo, { targetDirectoryId: "dir_target", createdAt: staleAt });
    const result = await runQueuedOwnerIngest({
      repository: repo,
      storage: fakeStorage(),
      now: () => NOW,
    });
    expect(result.status).toBe("rejected");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });

  it("缺少目标目录的审计记录 → failed(invalid_run)，绝不用兜底目录写盘", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedRun(repo, { targetDirectoryId: "dir_target" });
    // 抹掉目标目录：模拟一份不完整的 run 记录。
    const loaded = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    loaded!.workflowRun.auditEvents = [];
    await repo.saveWorkflowRunSnapshot(loaded!);
    let transferCalled = false;
    const result = await runQueuedOwnerIngest({
      repository: repo,
      storage: fakeStorage({
        transfer: async (input) => {
          transferCalled = true;
          return {
            id: "a",
            workflowRunId: input.workflowRunId,
            candidateId: "c1",
            status: "succeeded",
            providerMessage: "",
            materializedFileIds: [],
          };
        },
      }),
      now: () => NOW,
    });
    expect(transferCalled).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("没有排队任务 → idle（worker drain 的正常空转）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const result = await runQueuedOwnerIngest({ repository: repo, storage: fakeStorage() });
    expect(result.status).toBe("idle");
  });
});

/**
 * 终态写入**不可抛**（Dev 3020 实测的挂死形态）。
 *
 * 缺陷现场：修复前的 run 引用了一份被 `resource_snapshots` 全局主键
 * `ON CONFLICT DO NOTHING` 静默丢弃的快照；`saveWorkflowRunSnapshot` 的校验
 * 每次都拒，于是 `failRun` 也抛、run 永远停在 `running`，而 `running` 持有
 * 标题锁 —— 每次 drain 都失败一次，永远不收敛。
 *
 * 这条用例用一个「拒绝写子表」的仓储桩复现该形态：终态必须仍然落下。
 */
describe("failRun 的终态必须在子表校验失败时也落地", () => {
  it("首次写入被拒 → 退化为只写终态（不留在 running）", async () => {
    const repo = new InMemoryWorkflowRepository();
    // 造一份「引用了不存在快照的决策」的 run：validateWorkflowRunSnapshot 会拒。
    const runId = `oi_bad_${Math.random().toString(36).slice(2, 8)}`;
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "drive_1",
      title: title(),
      season: {
        id: "owner_ingest_drive_1_kw_s1",
        mediaTitleId: "owner_ingest_drive_1_kw",
        seasonNumber: 1,
        status: "completed",
        qualityPreference: "4K",
        storageDirectoryId: "dir_x",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "manual",
      },
      workflowRun: {
        id: runId,
        kind: "owner_ingest",
        status: "queued",
        trackedSeasonId: "owner_ingest_drive_1_kw_s1",
        startedAt: "2026-11-17T00:00:00.000Z",
        finishedAt: null,
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    // 让 claim 出的 run 里带上一条指向未知快照的决策（模拟历史脏数据）。
    const claimed = await repo.claimNextQueuedWorkflowRun({ kind: "owner_ingest", now: "2026-11-17T00:00:01.000Z" });
    expect(claimed).not.toBeNull();
    claimed!.decisions = [
      {
        node: "owner_ingest",
        snapshotId: "snapshot_that_was_silently_dropped",
        source: "human",
        selectedCandidateIds: ["c"],
        episodeMapping: {},
        providerAheadEpisodeMapping: {},
        rejectedCandidateIds: [],
        confidence: "high",
        reason: "stale",
      },
    ];

    const result = await runQueuedOwnerIngest({
      repository: {
        claimNextQueuedWorkflowRun: async () => claimed,
        saveWorkflowRunSnapshot: async (input: { resourceSnapshots: unknown[] }) => {
          // 子表非空 = 走「首次写入」路径，校验会拒（这里显式模拟）。
          if (input.resourceSnapshots.length > 0) throw new Error("Agent decision referenced unknown resource snapshot");
          await repo.saveWorkflowRunSnapshot(input as never);
        },
      } as never,
      storage: fakeStorage(),
      now: () => "2026-11-17T00:05:00.000Z",
    });

    expect(result.status).toBe("failed");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });
});
