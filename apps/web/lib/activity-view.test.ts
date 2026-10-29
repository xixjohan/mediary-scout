import { describe, expect, it, vi } from "vitest";
import {
  InMemoryWorkflowRepository,
  type AgentStep,
  type EpisodeState,
  type MediaTitle,
  type PersistWorkflowRunSnapshotInput,
  type TrackedSeason,
  type WorkflowKind,
  type WorkflowRepository,
  type WorkflowStatus,
} from "@media-track/workflow";
import { getActivityView } from "./activity-view";

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    ordinal: 1,
    toolName: "search",
    args: {},
    activity: "搜索 孤独摇滚",
    phase: "search",
    at: "2024-05-01T10:00:00Z",
    ...overrides,
  };
}

function title(tmdbId: number, name: string): MediaTitle {
  return { id: `t${tmdbId}`, tmdbId, type: "tv", title: name, originalTitle: name, year: 2026, aliases: [], posterPath: `/p${tmdbId}.jpg` };
}
function season(titleId: string, seasonNumber: number): TrackedSeason {
  return {
    id: `${titleId}_s${seasonNumber}`,
    mediaTitleId: titleId,
    seasonNumber,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
  };
}
function episode(seasonNumber: number, episodeNumber: number, trackedSeasonId = "s"): EpisodeState {
  return {
    trackedSeasonId,
    episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
    airDate: null,
    title: `Episode ${episodeNumber}`,
    airStatus: "aired",
    obtained: false,
    metadataStatus: "confirmed",
    verifiedFileIds: [],
  };
}
function run(input: {
  id: string;
  tmdbId: number;
  name: string;
  status: WorkflowStatus;
  startedAt: string;
  finishedAt?: string;
  episodes?: EpisodeState[];
  kind?: WorkflowKind;
}): PersistWorkflowRunSnapshotInput {
  const t = title(input.tmdbId, input.name);
  const s = season(t.id, 1);
  return {
    title: t,
    season: s,
    workflowRun: {
      id: input.id,
      kind: input.kind ?? "type2_init",
      status: input.status,
      trackedSeasonId: s.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      auditEvents: [],
    },
    episodes: input.episodes ?? [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications:
      input.finishedAt !== undefined
        ? [
            {
              id: `n_${input.id}`,
              workflowRunId: input.id,
              kind: "tracking_initialized",
              title: input.name,
              body: "done",
              createdAt: input.finishedAt,
              report: {
                titleName: input.name,
                seasonLabel: "第 1 季",
                status: "complete",
                lines: [],
                newlyObtained: [],
                realMissing: [],
                posterPath: `/p${input.tmdbId}.jpg`,
                fileCount: 12,
                totalBytes: 12 * 410 * 1024 * 1024,
              },
            },
          ]
        : [],
  };
}

describe("getActivityView", () => {
  it("active run over multiple seasons exposes the distinct sorted seasonNumbers", async () => {
    const repo = new InMemoryWorkflowRepository();
    const snap = run({
      id: "r_multi",
      tmdbId: 9,
      name: "Ozark",
      status: "running",
      startedAt: "2026-06-17T00:00:00Z",
      episodes: [episode(1, 1, "t9_s1"), episode(2, 1, "t9_s1"), episode(3, 1, "t9_s1"), episode(4, 1, "t9_s1")],
    });
    await repo.saveWorkflowRunSnapshot(snap);

    const view = await getActivityView({ repository: repo });
    const r = view.active.find((x) => x.runId === "r_multi")!;
    expect(r.seasonNumbers).toEqual([1, 2, 3, 4]);
  });

  it("returns active queued+running runs with queue positions; running carries progress", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q1", tmdbId: 2, name: "Queue1", status: "queued", startedAt: "2026-06-17T00:00:01Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q2", tmdbId: 3, name: "Queue2", status: "queued", startedAt: "2026-06-17T00:00:02Z" }));
    await repo.updateWorkflowRunProgress("r_run", { activity: "正在转存到网盘…", phase: "transfer", percent: 40, updatedAt: "t" });

    const view = await getActivityView({ repository: repo });

    const running = view.active.find((r) => r.runId === "r_run")!;
    expect(running.status).toBe("running");
    expect(running.progress?.activity).toBe("正在转存到网盘…");
    expect(running.queuePosition).toBeNull();
    const q1 = view.active.find((r) => r.runId === "r_q1")!;
    const q2 = view.active.find((r) => r.runId === "r_q2")!;
    expect(q1.queuePosition).toBe(1);
    expect(q2.queuePosition).toBe(2);
  });

  it("each active run carries its kind: cancelling a replace run is not cancelling an acquisition", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_acq", tmdbId: 1, name: "New", status: "queued", startedAt: "2026-06-17T00:00:00Z" }));
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_swap", tmdbId: 2, name: "Owned", status: "queued", startedAt: "2026-06-17T00:00:01Z", kind: "replace_request" }),
    );

    const view = await getActivityView({ repository: repo });

    expect(view.active.map((r) => [r.runId, r.kind])).toEqual(
      expect.arrayContaining([
        ["r_acq", "type2_init"],
        ["r_swap", "replace_request"],
      ]),
    );
  });

  it("a staging_recovery run is absent from the activity the user sees", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_hidden", tmdbId: 9, name: "Hidden", status: "running", startedAt: "2026-06-17T00:00:00Z", kind: "staging_recovery" }),
    );
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_seen", tmdbId: 8, name: "Seen", status: "queued", startedAt: "2026-06-17T00:00:01Z" }),
    );
    const view = await getActivityView({ repository: repo });
    expect(view.active.map((item) => item.runId)).toEqual(["r_seen"]);
    expect(view.recentCompleted.map((item) => item.workflowRunId)).not.toContain("r_hidden");
  });

  it("a replace run reads at the title level: its lock season's episodes say nothing about what it covers", async () => {
    // A request for S02E01 locks the title on its first tracked season; the snapshot
    // holds S01's episodes (two of them missing) — neither the season nor the count is
    // what the run is about.
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({
        id: "r_swap",
        tmdbId: 2,
        name: "Owned",
        status: "queued",
        startedAt: "2026-06-17T00:00:01Z",
        kind: "replace_request",
        episodes: [episode(1, 1, "t2_s1"), episode(1, 2, "t2_s1")],
      }),
    );

    const [swap] = (await getActivityView({ repository: repo })).active;

    expect(swap).toMatchObject({ kind: "replace_request", seasonNumber: null, seasonNumbers: [], missingCount: 0 });
  });

  it("recentCompleted carries finished runs with runId + size, excluding no-op patrol checks (client scopes by observed runs)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_done", tmdbId: 2, name: "Done", status: "succeeded", startedAt: "2026-06-17T00:01:00Z", finishedAt: "2026-06-17T00:01:30Z" }));

    const view = await getActivityView({ repository: repo });

    const done = view.recentCompleted.find((c) => c.title === "Done")!;
    expect(done.workflowRunId).toBe("r_done");
    expect(done.sizeText).toBe("每集 约 410 MB");
  });

  it("backfills a missing recentCompleted poster from the tracked title (old notifications lack posterPath)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const snap = run({ id: "r_old", tmdbId: 7, name: "OldNoPoster", status: "succeeded", startedAt: "2026-06-17T00:02:00Z", finishedAt: "2026-06-17T00:02:30Z" });
    // Simulate an OLD notification written before reports carried posterPath.
    snap.notifications[0]!.report!.posterPath = null;
    await repo.saveWorkflowRunSnapshot(snap);

    const view = await getActivityView({ repository: repo });

    const done = view.recentCompleted.find((c) => c.title === "OldNoPoster")!;
    expect(done.posterPath).toBe("/p7.jpg"); // backfilled from the still-tracked title
  });

  it("scopes active runs to the requested drive (connectedStorageId)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const onA = run({ id: "r_a", tmdbId: 1, name: "Alpha", status: "running", startedAt: "2026-06-19T00:00:00Z" });
    onA.accountId = "acct_default";
    onA.connectedStorageId = "cs_a";
    const onB = run({ id: "r_b", tmdbId: 2, name: "Beta", status: "running", startedAt: "2026-06-19T00:00:00Z" });
    onB.accountId = "acct_default";
    onB.connectedStorageId = "cs_b";
    await repo.saveWorkflowRunSnapshot(onA);
    await repo.saveWorkflowRunSnapshot(onB);

    const viewA = await getActivityView({ repository: repo, accountId: "acct_default", connectedStorageId: "cs_a" });
    expect(viewA.active.map((r) => r.title)).toEqual(["Alpha"]);

    const viewB = await getActivityView({ repository: repo, accountId: "acct_default", connectedStorageId: "cs_b" });
    expect(viewB.active.map((r) => r.title)).toEqual(["Beta"]);
  });
});

/**
 * W4 L1：active run 内嵌的 agent 工具调用时间线。
 *
 * 三条断言对应三个真实风险：
 *   ① queued 的 run **不发起** listAgentSteps 读——否则每 8 秒轮询都对每个排队项
 *      白读一次永远为空的表。这不是省事，是性能正确性。
 *   ② scope 原样透传给 listAgentSteps——该端口自身 fail-closed，漏传 scope 会让
 *      别的账号的 trace 漏出来。
 *   ③ 到达响应的 steps 已脱敏（plan 把脱敏列为「本方案安全风险最高的一项」：
 *      「一个登录态用户就能在 UI 里看到自己的网盘 cookie」）。
 */
describe("getActivityView — L1 agent 时间线", () => {
  it("running 的 run 带脱敏 steps；诊断字段保留（要能复盘）", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }),
    );
    await repo.appendAgentStep(
      "r_run",
      step({ args: { cookie: "UID=1_C1_2;CID=abc", url: "https://115.com/s/swxy8ab", keyword: "孤独摇滚" } }),
    );
    await repo.appendAgentStep("r_run", step({ ordinal: 2, activity: "转存到网盘", phase: "transfer", apiCalls: 9 }));

    const view = await getActivityView({ repository: repo });
    const running = view.active.find((r) => r.runId === "r_run")!;

    expect(running.steps).toHaveLength(2);
    const serialized = JSON.stringify(running.steps);
    expect(serialized).not.toMatch(/(?:https?|magnet):\/\//i);
    expect(serialized).not.toContain("UID=1_C1_2");
    expect(serialized).not.toContain("swxy8ab");
    // 脱敏不能连复盘能力一起删掉
    expect(running.steps[0]!.activity).toBe("搜索 孤独摇滚");
    // 脱敏是**整值替换**（保留键名），不是删键：时间线要能看出「这个工具收过
    // cookie/url」，只是值不可见。
    expect(running.steps[0]!.args).toEqual({
      cookie: "[已脱敏]",
      url: "[已脱敏]",
      keyword: "孤独摇滚",
    });
    expect(running.steps[1]!.apiCalls).toBe(9);
  });

  it("queued 的 run steps 为空，且不发起 listAgentSteps 读", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_q", tmdbId: 2, name: "Queued", status: "queued", startedAt: "2026-06-17T00:00:00Z" }),
    );
    const listAgentSteps = vi.spyOn(repo, "listAgentSteps");

    const view = await getActivityView({ repository: repo });
    expect(view.active.find((r) => r.runId === "r_q")!.steps).toEqual([]);
    expect(listAgentSteps).not.toHaveBeenCalled();
  });

  it("混合队列：只读 running 的那些", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }),
    );
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_q", tmdbId: 2, name: "Queued", status: "queued", startedAt: "2026-06-17T00:00:01Z" }),
    );
    await repo.appendAgentStep("r_run", step());
    const listAgentSteps = vi.spyOn(repo, "listAgentSteps");

    await getActivityView({ repository: repo });

    expect(listAgentSteps.mock.calls.map((call) => call[0])).toEqual(["r_run"]);
  });

  it("scope 原样透传给 listAgentSteps（该端口自身 fail-closed）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const mine = run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" });
    mine.accountId = "acct_a";
    mine.connectedStorageId = "cs_a";
    await repo.saveWorkflowRunSnapshot(mine);
    const listAgentSteps = vi.spyOn(repo, "listAgentSteps");

    await getActivityView({ repository: repo, accountId: "acct_a", connectedStorageId: "cs_a" });

    expect(listAgentSteps).toHaveBeenCalledWith("r_run", { accountId: "acct_a", connectedStorageId: "cs_a" });
  });

  it("时间线取尾 50 条（不把搜索期刷满面板）", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(
      run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }),
    );
    for (let i = 1; i <= 120; i += 1) {
      await repo.appendAgentStep("r_run", step({ ordinal: i }));
    }

    const view = await getActivityView({ repository: repo });
    const steps = view.active.find((r) => r.runId === "r_run")!.steps;
    expect(steps).toHaveLength(50);
    expect(steps[0]!.ordinal).toBe(71);
    expect(steps[steps.length - 1]!.ordinal).toBe(120);
  });

  it("别的账号的 run 不透出 trace（listAgentSteps 的 scope 门控真实生效）", async () => {
    const repo = new InMemoryWorkflowRepository();
    const foreign = run({ id: "r_foreign", tmdbId: 5, name: "Foreign", status: "running", startedAt: "2026-06-17T00:00:00Z" });
    foreign.accountId = "acct_other";
    await repo.saveWorkflowRunSnapshot(foreign);
    await repo.appendAgentStep("r_foreign", step({ activity: "别人的搜索" }));

    // 用别的账号视角请求：该 run 根本不在其作用域内
    const view = await getActivityView({ repository: repo, accountId: "acct_default" });
    expect(view.active.map((r) => r.runId)).not.toContain("r_foreign");
  });

  it("当指定 connectedStorageId 时，自动合并账号下未绑盘（unscoped）的活跃任务，防止视界盲区", async () => {
    const repo = new InMemoryWorkflowRepository();
    // 1. 明确绑定在 drive_1 的任务
    const scopedRun = run({
      id: "r_scoped",
      tmdbId: 101,
      name: "Scoped Run",
      status: "running",
      startedAt: "2026-06-17T00:00:00Z",
    });
    scopedRun.accountId = "acct_user";
    scopedRun.connectedStorageId = "drive_1";
    await repo.saveWorkflowRunSnapshot(scopedRun);

    // 2. 未绑盘（unscoped）的任务（如未追踪电影手动入库）
    const unscopedRun = run({
      id: "r_unscoped",
      tmdbId: 102,
      name: "Wildwood",
      status: "running",
      startedAt: "2026-06-17T00:00:01Z",
      kind: "manual_import",
    });
    unscopedRun.accountId = "acct_user";
    unscopedRun.connectedStorageId = null;
    await repo.saveWorkflowRunSnapshot(unscopedRun);

    // 3. 属于 drive_2 的隔离任务
    const otherDriveRun = run({
      id: "r_other",
      tmdbId: 103,
      name: "Other Drive",
      status: "running",
      startedAt: "2026-06-17T00:00:02Z",
    });
    otherDriveRun.accountId = "acct_user";
    otherDriveRun.connectedStorageId = "drive_2";
    await repo.saveWorkflowRunSnapshot(otherDriveRun);

    // 在 drive_1 视图下请求
    const view = await getActivityView({
      repository: repo,
      accountId: "acct_user",
      connectedStorageId: "drive_1",
    });

    const activeIds = view.active.map((r) => r.runId);
    expect(activeIds).toContain("r_scoped");
    expect(activeIds).toContain("r_unscoped"); // 成功级联展示通用任务
    expect(activeIds).not.toContain("r_other"); // 跨盘任务维持隔离
  });
});
