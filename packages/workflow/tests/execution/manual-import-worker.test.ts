import { describe, expect, it } from "vitest";
import type { MediaTitle, ResourceSnapshot, TransferAttempt } from "../../src/domain.js";
import type { StorageExecutor } from "../../src/domain/ports.js";
import { InMemoryWorkflowRepository } from "../../src/persistence/repository.js";
import { MANUAL_IMPORT_TTL_MS } from "../../src/execution/manual-import-resolver.js";
import { runQueuedManualImport, transitionClaimedRunStatus } from "../../src/execution/manual-import-worker.js";
import { Pan115AuthError } from "../../src/storage/pan115-cookie-client.js";

/**
 * The worker half of manual import.
 *
 * The point of these tests is NOT that a transfer happens — the executor is a fake.
 * It is that the run cannot end up stranded: every path either succeeds, fails
 * terminally, or is rejected, and `queued` is never left behind. A `queued`
 * `manual_import` run counts as active and blocks its title (it was reserved with
 * `blockIfTitleHasActiveRun`), so "nothing claims this kind" is not a cosmetic gap.
 */

const NOW_MS = Date.parse("2026-01-10T12:00:00.000Z");
const FRESH_AT = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
const STALE_AT = new Date(NOW_MS - MANUAL_IMPORT_TTL_MS - 60_000).toISOString();

function title(type: "tv" | "movie" | "anime" = "tv"): MediaTitle {
  return {
    id: "t1",
    tmdbId: 283428,
    type,
    title: "孤独摇滚",
    originalTitle: "Bocchi the Rock!",
    year: 2022,
    aliases: [],
  };
}

function season() {
  return {
    id: "t1_s1",
    mediaTitleId: "t1",
    seasonNumber: 1,
    status: "active" as const,
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata" as const,
  };
}

function snapshot(id: string, createdAt: string, candidateId = "c1"): ResourceSnapshot {
  return {
    id,
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt,
    candidates: [
      {
        id: candidateId,
        snapshotId: id,
        index: 0,
        title: "孤独摇滚 S01E01",
        type: "115" as const,
        source: "pansou-115",
        providerPayload: { url: "https://115.com/s/leak", password: "abcd" },
      },
    ],
  };
}

function fakeStorage(overrides: Partial<StorageExecutor> = {}): StorageExecutor {
  const storage: StorageExecutor = {
    createDirectory: async ({ name }) => `dir_${name}`,
    listVideoFiles: async () => [],
    listUnparsedVideoFiles: async () => [],
    renameFile: async () => {},
    transfer: async (input): Promise<TransferAttempt> => ({
      id: "att1",
      // 必须回写真实 run id：仓储会校验 attempt 属于该 run，写死一个常量会被拒。
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
    // 原先没有这三个，是 `as StorageExecutor` 把它们盖住了。manual-import 不调用它们，
    // 补空实现只为让这个 fake 真的满足端口——否则端口加方法时这里不会报错。
    listTree: async () => [],
    listSubdirectories: async () => [],
    moveFiles: async () => ({ moved: [] }),
  };
  // Partial 展开在 exactOptionalPropertyTypes 下会把可选属性变成 `T | undefined`，
  // 与端口声明的 `?: T` 不相容。强转只掩盖这一处合并，方法体本身仍受上下文类型约束。
  return { ...storage, ...overrides } as StorageExecutor;
}

/** Queue a manual_import run the way the HTTP route does. */
async function seedQueuedRun(
  repo: InMemoryWorkflowRepository,
  opts: {
    snap: ResourceSnapshot;
    candidateId: string;
    titleType?: "tv" | "movie" | "anime";
    accountId?: string;
    connectedStorageId?: string;
  },
): Promise<string> {
  const accountId = opts.accountId ?? "acct_default";
  const runId = `mi_${Math.random().toString(36).slice(2, 8)}`;
  await repo.saveWorkflowRunSnapshot({
    accountId,
    ...(opts.connectedStorageId ? { connectedStorageId: opts.connectedStorageId } : {}),
    title: title(opts.titleType ?? "tv"),
    season: season(),
    workflowRun: {
      id: runId,
      kind: "manual_import",
      status: "queued",
      trackedSeasonId: "t1_s1",
      startedAt: FRESH_AT,
      finishedAt: null,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [opts.snap],
    decisions: [
      {
        node: "manual_import",
        snapshotId: opts.snap.id,
        selectedCandidateIds: [opts.candidateId],
        episodeMapping: {},
        providerAheadEpisodeMapping: {},
        rejectedCandidateIds: [],
        confidence: "high",
        reason: "用户手动选择",
        source: "human",
      },
    ],
    transferAttempts: [],
    notifications: [],
  });
  return runId;
}

describe("runQueuedManualImport — 放行路径", () => {
  it("合法候选 ⇒ succeeded，run 落库为 succeeded 且带一条转存记录", async () => {
    const repo = new InMemoryWorkflowRepository();
    const snap = snapshot("snap-1", FRESH_AT);
    const runId = await seedQueuedRun(repo, { snap, candidateId: "c1" });

    const result = await runQueuedManualImport({
      repository: repo,
      storage: fakeStorage(),
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.workflowRunId).toBe(runId);
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("succeeded");
    expect(saved!.transferAttempts).toHaveLength(1);
    expect(saved!.transferAttempts[0]!.candidateId).toBe("c1");
  });

  it("**转存进规范目录**：Title (Year) {tmdb-N} 下的 Season 01", async () => {
    const repo = new InMemoryWorkflowRepository();
    const created: string[] = [];
    const storage = fakeStorage({
      createDirectory: async ({ name }) => {
        created.push(name);
        return `dir_${name}`;
      },
      transfer: async (input) => {
        expect(input.directoryId).toBe("dir_Season 01");
        return {
          id: "a",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "succeeded",
          providerMessage: "",
          materializedFileIds: [],
        };
      },
    });
    await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1" });
    await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(created).toEqual(["孤独摇滚 (2022) {tmdb-283428}", "Season 01"]);
  });

  it("电影直接进标题目录，不建 Season 子目录", async () => {
    const repo = new InMemoryWorkflowRepository();
    let into = "";
    const storage = fakeStorage({
      transfer: async (input) => {
        into = input.directoryId;
        return {
          id: "a",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "succeeded",
          providerMessage: "",
          materializedFileIds: [],
        };
      },
    });
    await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1", titleType: "movie" });
    await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "movie_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(into).toBe("dir_孤独摇滚 (2022) {tmdb-283428}");
  });
});

describe("runQueuedManualImport — 不会留下 queued 的 run", () => {
  it("超 30 分钟（在队列里等过窗口）⇒ rejected，run 终态失败", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedQueuedRun(repo, { snap: snapshot("s", STALE_AT), candidateId: "c1" });
    const result = await runQueuedManualImport({
      repository: repo,
      storage: fakeStorage(),
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("expired");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });

  it("**「候选不属于快照」这个状态，仓储根本不让落库**", async () => {
    // 这是 worker 里那重归属校验为什么是纵深防御而非主防线：DB 自己不接受
    // 引用快照外候选的 decision。两层各自独立，但先挡住的是这一层。
    const repo = new InMemoryWorkflowRepository();
    await expect(
      repo.saveWorkflowRunSnapshot({
        accountId: "acct_default",
        title: title(),
        season: season(),
        workflowRun: {
          id: "mi_bad",
          kind: "manual_import",
          status: "queued",
          trackedSeasonId: "t1_s1",
          startedAt: FRESH_AT,
          finishedAt: null,
          auditEvents: [],
        },
        episodes: [],
        resourceSnapshots: [snapshot("s", FRESH_AT, "c1")],
        decisions: [
          {
            node: "manual_import",
            snapshotId: "s",
            selectedCandidateIds: ["intruder"],
            episodeMapping: {},
            providerAheadEpisodeMapping: {},
            rejectedCandidateIds: [],
            confidence: "high",
            reason: "用户手动选择",
            source: "human",
          },
        ],
        transferAttempts: [],
        notifications: [],
      }),
    ).rejects.toThrow(/outside persisted resource snapshots/);
  });

  it("网盘抛错 ⇒ failed（不是 running，不会堵死标题）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const storage = fakeStorage({
      transfer: async () => {
        throw new Error("drive exploded");
      },
    });
    const runId = await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1" });
    const result = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("transfer_error");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });

  it("转存未成功 ⇒ failed", async () => {
    const repo = new InMemoryWorkflowRepository();
    const storage = fakeStorage({
      transfer: async (input) => ({
        id: "a",
        workflowRunId: input.workflowRunId,
        candidateId: "c1",
        status: "failed",
        providerMessage: "分享链接已失效",
        materializedFileIds: [],
      }),
    });
    const runId = await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1" });
    const result = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("failed");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });

  it("run 缺 decision ⇒ failed，不猜", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = `mi_nodecision`;
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      title: title(),
      season: season(),
      workflowRun: {
        id: runId,
        kind: "manual_import",
        status: "queued",
        trackedSeasonId: "t1_s1",
        startedAt: FRESH_AT,
        finishedAt: null,
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [snapshot("s", FRESH_AT)],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const result = await runQueuedManualImport({
      repository: repo,
      storage: fakeStorage(),
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("failed");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
  });
});

describe("runQueuedManualImport — §7 per-account 盘", () => {
  it("**解析器给出的盘才是转存目标**（bob 的导入不能落默认账号的盘）", async () => {
    const repo = new InMemoryWorkflowRepository();
    // bob 的 run：若解析时把 accountId 写死成默认账号，这条会红
    await seedQueuedRun(repo, {
      snap: snapshot("s", FRESH_AT),
      candidateId: "c1",
      accountId: "acct_bob",
    });

    const defaultCalls: string[] = [];
    const bobCalls: string[] = [];
    const defaultStorage = fakeStorage({
      createDirectory: async ({ name }) => {
        defaultCalls.push(name);
        return `def_${name}`;
      },
    });
    const bobStorage = fakeStorage({
      createDirectory: async ({ name }) => {
        bobCalls.push(name);
        return `bob_${name}`;
      },
      transfer: async (input) => {
        expect(input.directoryId).toBe("bob_Season 01");
        return {
          id: "a",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "succeeded",
          providerMessage: "",
          materializedFileIds: [],
        };
      },
    });

    let resolvedAccountId = "";
    const result = await runQueuedManualImport({
      repository: repo,
      storage: defaultStorage,
      categoryParentDirectoryId: "tv_root",
      resolveAccountContext: async (accountId) => {
        resolvedAccountId = accountId;
        return { storage: bobStorage };
      },
      now: () => new Date(NOW_MS).toISOString(),
    });

    expect(result.status).toBe("succeeded");
    expect(resolvedAccountId).toBe("acct_bob");
    expect(bobCalls).toEqual(["孤独摇滚 (2022) {tmdb-283428}", "Season 01"]);
    // 默认账号的盘一次都没碰
    expect(defaultCalls).toEqual([]);
  });

  it("解析器不给盘 ⇒ 回落到传入的默认盘", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1" });
    let used = "";
    const storage = fakeStorage({
      transfer: async (input) => {
        used = input.directoryId;
        return {
          id: "a",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "succeeded",
          providerMessage: "",
          materializedFileIds: [],
        };
      },
    });
    const result = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      resolveAccountContext: async () => ({}),
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("succeeded");
    expect(used).toBe("dir_Season 01");
  });
});

describe("runQueuedManualImport — 空队列", () => {
  it("没有 queued 的 manual_import ⇒ idle，不碰网盘", async () => {
    const repo = new InMemoryWorkflowRepository();
    let touched = false;
    const storage = fakeStorage({
      createDirectory: async () => {
        touched = true;
        return "x";
      },
    });
    const result = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("idle");
    expect(touched).toBe(false);
  });

  it("只认自己的 kind：type2_init 排队时不动它", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      title: title(),
      season: season(),
      workflowRun: {
        id: "other",
        kind: "type2_init",
        status: "queued",
        trackedSeasonId: "t1_s1",
        startedAt: FRESH_AT,
        finishedAt: null,
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const result = await runQueuedManualImport({
      repository: repo,
      storage: fakeStorage(),
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(result.status).toBe("idle");
    const saved = await repo.getWorkflowRunSnapshot("other", "acct_default");
    expect(saved!.workflowRun.status).toBe("queued");
  });
});

describe("runQueuedManualImport — 多网盘分类路由与异常状态机护栏", () => {
  it("按标题类型（movie / anime / tv）精准路由到对应网盘分类目录", async () => {
    for (const [titleType, expectedParent] of [
      ["movie", "drive2_movies_cid"],
      ["anime", "drive2_anime_cid"],
      ["tv", "drive2_tv_cid"],
    ] as const) {
      const repo = new InMemoryWorkflowRepository();
      const parentsUsed: string[] = [];
      const storage = fakeStorage({
        listChildDirectories: async (parentId) => {
          parentsUsed.push(parentId);
          return [];
        },
      });
      await seedQueuedRun(repo, {
        snap: snapshot("s", FRESH_AT),
        candidateId: "c1",
        titleType,
        connectedStorageId: "cs_drive2",
      });
      const res = await runQueuedManualImport({
        repository: repo,
        storage: fakeStorage(),
        categoryParentDirectoryId: "wrong_fallback",
        resolveAccountContext: async () => ({
          storage,
          storageParentDirectoryId: "drive2_tv_cid",
          animeStorageParentDirectoryId: "drive2_anime_cid",
          moviesParentDirectoryId: "drive2_movies_cid",
        }),
        now: () => new Date(NOW_MS).toISOString(),
      });
      expect(res.status).toBe("succeeded");
      expect(parentsUsed[0]).toBe(expectedParent);
    }
  });

  it("Season NN 已存在时幂等复用已有目录 ID，不重复调用 createDirectory", async () => {
    const repo = new InMemoryWorkflowRepository();
    const created: string[] = [];
    let transferredTo = "";
    const storage = fakeStorage({
      listChildDirectories: async (parentId) => {
        if (parentId === "tv_root") return [{ id: "show_1", name: "孤独摇滚 (2022) {tmdb-283428}" }];
        if (parentId === "show_1") return [{ id: "existing_s01", name: "Season 01" }];
        return [];
      },
      createDirectory: async ({ name }) => {
        created.push(name);
        return `new_${name}`;
      },
      transfer: async (input) => {
        transferredTo = input.directoryId;
        return {
          id: "a",
          workflowRunId: input.workflowRunId,
          candidateId: "c1",
          status: "succeeded",
          providerMessage: "",
          materializedFileIds: ["f1"],
        };
      },
    });
    await seedQueuedRun(repo, { snap: snapshot("s", FRESH_AT), candidateId: "c1" });
    const res = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(res.status).toBe("succeeded");
    expect(transferredTo).toBe("existing_s01");
    expect(created).toEqual([]);
  });

  it("目录创建阶段抛错并触发网盘鉴权失效 ⇒ 安全收口为 failed（绝不残留 running），且调用 onAuthErrorFreeze", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedQueuedRun(repo, {
      snap: snapshot("s", FRESH_AT),
      candidateId: "c1",
      connectedStorageId: "cs_pan115_dead",
    });
    let frozenDriveId = "";
    let frozenReason = "";
    const storage = fakeStorage({
      listChildDirectories: async () => {
        throw new Pan115AuthError("PAN115_COOKIE_EXPIRED: 115 cookie dead", 99);
      },
    });
    const res = await runQueuedManualImport({
      repository: repo,
      storage,
      categoryParentDirectoryId: "tv_root",
      onAuthErrorFreeze: async (storageId, reason) => {
        frozenDriveId = storageId;
        frozenReason = reason;
      },
      now: () => new Date(NOW_MS).toISOString(),
    });
    expect(res.status).toBe("failed");
    expect(frozenDriveId).toBe("cs_pan115_dead");
    expect(frozenReason).toContain("PAN115_COOKIE_EXPIRED");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
    expect(saved!.workflowRun.auditEvents.some((e) => e.type === "manual_import_failed")).toBe(true);
  });

  it("resolveAccountContext 阶段抛错 ⇒ 同样由 try/catch 兜底置为 failed（绝不残留 running），且保持确定性时钟", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runId = await seedQueuedRun(repo, {
      snap: snapshot("s", FRESH_AT),
      candidateId: "c1",
      connectedStorageId: "cs_resolve_boom",
    });
    const fixedNow = "2026-01-10T12:00:00.000Z";
    const res = await runQueuedManualImport({
      repository: repo,
      storage: fakeStorage(),
      categoryParentDirectoryId: "tv_root",
      resolveAccountContext: async () => {
        throw new Error("DB_DECRYPT_FAILURE");
      },
      now: () => fixedNow,
    });
    expect(res.status).toBe("failed");
    const saved = await repo.getWorkflowRunSnapshot(runId, "acct_default");
    expect(saved!.workflowRun.status).toBe("failed");
    expect(saved!.workflowRun.finishedAt).toBe(fixedNow);
  });

  it("transitionClaimedRunStatus 拒绝从非 running 状态跃迁至终态", () => {
    expect(() =>
      transitionClaimedRunStatus(
        {
          id: "r1",
          kind: "manual_import",
          status: "succeeded",
          trackedSeasonId: "t1_s1",
          startedAt: FRESH_AT,
          finishedAt: FRESH_AT,
          auditEvents: [],
        },
        "failed",
        FRESH_AT,
      ),
    ).toThrow(/Illegal workflow run state transition/);
  });
});
