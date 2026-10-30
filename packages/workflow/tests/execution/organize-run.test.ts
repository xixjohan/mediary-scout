import { describe, expect, it } from "vitest";
import type { PersistWorkflowRunSnapshotInput } from "../../src/repository.js";
import {
  ORGANIZE_KIND,
  buildOrganizeRun,
  organizeIsUserVisible,
  organizePlanCopy,
  organizeRunId,
} from "../../src/organize-run.js";
import { planOrganizeMoves } from "../../src/organize-plan.js";
import { tearsDownTrackingOnCancel } from "../../src/repository.js";
import { isUserVisibleWorkflowKind } from "../../src/domain.js";

/**
 * Batch 4 的 run 形态。
 *
 * 关键断言不是「字段填对了」，而是**两种计划的终局不同**：deterministic 记 succeeded
 * 且不写 unresolved，manual_review 记 failed 且把未解析文件和建议目标一起留下——
 * 因为前端要拿这些去列给用户看。一个只有 status 的复核会把用户推回网盘浏览器自己找。
 */

const TITLE: PersistWorkflowRunSnapshotInput["title"] = {
  id: "t1",
  tmdbId: 1396,
  mediaType: "tv",
  name: "绝命毒师",
  originalName: "Breaking Bad",
  year: 2008,
  overview: "",
  posterPath: null,
  backdropPath: null,
  genres: [],
  numberOfSeasons: 5,
  originCountry: [],
  firstAirDate: "2008-01-20",
  status: "Ended",
} as unknown as PersistWorkflowRunSnapshotInput["title"];

const SEASON: PersistWorkflowRunSnapshotInput["season"] = {
  id: "s1",
  mediaTitleId: "t1",
  seasonNumber: 1,
  name: "第一季",
  overview: "",
  posterPath: null,
  airDate: null,
  episodeCount: 7,
  storageDirectoryId: "dir_season_01",
  obtained: 0,
} as unknown as PersistWorkflowRunSnapshotInput["season"];

function plan(files: { fileName: string; fileId: string }[], targetSeasons: number[] = [1]) {
  return planOrganizeMoves({
    files,
    targetSeasons,
    resolveTargetDirectory: (season) => `dir_season_0${season}`,
  });
}

const CLEAN = [
  { fileName: "Breaking Bad S01E01.mkv", fileId: "f1" },
  { fileName: "Breaking Bad S01E02.mkv", fileId: "f2" },
];
const MESSY = [
  { fileName: "Breaking Bad S01E01.mkv", fileId: "f1" },
  { fileName: "random-clip.mp4", fileId: "f2" },
];

describe("organizeRunId", () => {
  it("按标题 + 季号派生（幂等，重复整理复用同一 run）", () => {
    expect(organizeRunId("t1", 1)).toBe("organize_t1_s1");
    expect(organizeRunId("t1", undefined)).toBe("organize_t1");
  });
});

describe("buildOrganizeRun — deterministic 计划", () => {
  const run = buildOrganizeRun({
    title: TITLE,
    season: SEASON,
    sourceDirectoryId: "dir_staging",
    plan: plan(CLEAN),
    accountId: "acct_default",
    now: "2026-01-01T00:00:00.000Z",
  });

  it("kind 是 title_organize", () => {
    expect(run.workflowRun.kind).toBe(ORGANIZE_KIND);
    expect(ORGANIZE_KIND).toBe("title_organize");
  });

  it("终局 succeeded，finishedAt 落库", () => {
    expect(run.workflowRun.status).toBe("succeeded");
    expect(run.workflowRun.finishedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("planned moves 写在 run 的 audit 事件里", () => {
    expect(run.workflowRun.auditEvents).toHaveLength(1);
    expect(run.workflowRun.auditEvents[0]!.type).toBe("organize_planned_moves");
    const moves = run.workflowRun.auditEvents[0]!.data!["moves"];
    expect(Array.isArray(moves)).toBe(true);
    expect((moves as unknown[]).length).toBe(2);
  });

  it("**没有 unresolved 字段**（确定性计划不存在未解析文件）", () => {
    const data = run.workflowRun.auditEvents[0]!.data!;
    expect("unresolved" in data).toBe(false);
  });

  it("带 sourceDirectoryId（复核时要知道从哪来的）", () => {
    expect(run.workflowRun.auditEvents[0]!.data!["sourceDirectoryId"]).toBe("dir_staging");
  });

  it("有一条 agent 决策（与手动入库的 agent_decisions 同源）", () => {
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]!.source).toBe("agent");
    expect(run.decisions[0]!.node).toBe("organize");
  });
});

describe("buildOrganizeRun — manual_review 计划", () => {
  const run = buildOrganizeRun({
    title: TITLE,
    season: SEASON,
    sourceDirectoryId: "dir_staging",
    plan: plan(MESSY),
    accountId: "acct_default",
    now: "2026-01-01T00:00:00.000Z",
  });

  it("**终局 failed，不是 succeeded**", () => {
    expect(run.workflowRun.status).toBe("failed");
  });

  it("**unresolved 连原因一起留下**（前端要列给用户看）", () => {
    const data = run.workflowRun.auditEvents[0]!.data!;
    const unresolved = data["unresolved"];
    expect(Array.isArray(unresolved)).toBe(true);
    const list = unresolved as unknown[];
    expect(list).toHaveLength(1);
    expect((list[0] as { reason: string }).reason).toBe("no_episode_code");
    expect((list[0] as { fileName: string }).fileName).toBe("random-clip.mp4");
  });

  it("能放的那条 move 仍然记下（供前端预填建议目标）", () => {
    const data = run.workflowRun.auditEvents[0]!.data!;
    expect((data["moves"] as unknown[]).length).toBe(1);
  });

  it("没有 agent 决策（没有替用户做选择）", () => {
    expect(run.decisions).toHaveLength(0);
  });

  it("建议目标带 seasonNumber 时一定带上", () => {
    const ambiguous = buildOrganizeRun({
      title: TITLE,
      season: SEASON,
      sourceDirectoryId: "dir_staging",
      plan: plan([{ fileName: "海贼王 第1050集.mp4", fileId: "f9" }], [1, 2]),
      accountId: "acct_default",
      now: "2026-01-01T00:00:00.000Z",
    });
    const data = ambiguous.workflowRun.auditEvents[0]!.data!;
    const entry = (data["unresolved"] as unknown[])[0] as Record<string, unknown>;
    expect(entry["suggestedEpisodeCode"]).toBe("S01E1050");
  });
});

describe("organizePlanCopy", () => {
  it("确定性计划说「可确定性放置」", () => {
    expect(organizePlanCopy(plan(CLEAN))).toContain("确定性放置");
  });

  it("复核计划说清两个数", () => {
    const copy = organizePlanCopy(plan(MESSY));
    expect(copy).toContain("1 个文件可放置");
    expect(copy).toContain("1 个需人工复核");
  });
});

describe("organize 在系统里的位置", () => {
  it("**用户可见**（看不见的复核等于没有复核）", () => {
    expect(organizeIsUserVisible()).toBe(true);
    expect(isUserVisibleWorkflowKind(ORGANIZE_KIND)).toBe(true);
  });

  it("**取消不拆跟踪**（整理的是已有库，不是初始化）", () => {
    expect(tearsDownTrackingOnCancel(ORGANIZE_KIND)).toBe(false);
  });
});
