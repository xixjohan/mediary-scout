import type { PersistWorkflowRunSnapshotInput } from "../persistence/repository.js";
import type { AgentDecision, WorkflowKind, WorkflowRun } from "../domain/domain.js";
import { decisionFromSelection } from "./candidate-selector.js";
import type { OrganizePlan } from "./organize-plan.js";

/**
 * Batch 4: the run record an 自动整理 leaves behind.
 *
 * A run (rather than a bare HTTP round-trip) because the plan's guardrail needs a
 * place to put the planned moves BEFORE anything is executed, and a place to put the
 * drift when the comparison fails. `executeOrganizePlan` writes those as audit events
 * on the run it is given; this is the shape of that run.
 *
 * `title_organize` is user-visible on purpose: its most interesting outcome is
 * `manual_review`, and a review the user cannot see is a review that never happens.
 * That makes it noisier than `resource_search` — but the alternative is a silent
 * half-organized library, which is the exact failure the plan is guarding against.
 */

export const ORGANIZE_KIND: WorkflowKind = "title_organize";

/** The run id an organize of a title/season is recorded under. */
export function organizeRunId(titleId: string, seasonNumber: number | undefined): string {
  return seasonNumber === undefined
    ? `organize_${titleId}`
    : `organize_${titleId}_s${seasonNumber}`;
}

/**
 * Build the reservation for an organize run.
 *
 * `manualReview` is carried in the run rather than inferred from a status, because the
 * front end needs the *files and their suggested targets* — a bare status would send
 * the user back to a drive browser to find out what was ambiguous.
 */
export function buildOrganizeRun(input: {
  title: PersistWorkflowRunSnapshotInput["title"];
  season: PersistWorkflowRunSnapshotInput["season"];
  /** The directory the files were found in. */
  sourceDirectoryId: string;
  plan: OrganizePlan;
  accountId: string;
  connectedStorageId?: string | null;
  now: string;
}): PersistWorkflowRunSnapshotInput {
  const runId = organizeRunId(input.title.id, input.season?.seasonNumber);
  const status: WorkflowRun["status"] = input.plan.kind === "deterministic" ? "succeeded" : "failed";
  const decisions: AgentDecision[] =
    input.plan.kind === "deterministic"
      ? [
          decisionFromSelection({
            selection: {
              selectedCandidateIds: input.plan.moves.map((move) => move.fileId),
              confidence: "high",
              reason: "命名规范，确定性放置",
            },
            // 整理不消费候选，但 decisionFromSelection 要求一个快照——它只用 id 作
            // snapshotId 字段。这里给一个同形的占位快照，而不是改端口签名去迎合一个
            // 没有候选的场景。
            snapshot: {
              id: runId,
              provider: "organize",
              keyword: "",
              createdAt: input.now,
              candidates: [],
            },
            source: "agent",
            node: "organize",
          }),
        ]
      : [];

  return {
    accountId: input.accountId,
    ...(input.connectedStorageId === undefined || input.connectedStorageId === null
      ? {}
      : { connectedStorageId: input.connectedStorageId }),
    title: input.title,
    season: input.season,
    workflowRun: {
      id: runId,
      kind: ORGANIZE_KIND,
      status,
      trackedSeasonId: input.season?.id ?? "",
      startedAt: input.now,
      finishedAt: input.now,
      auditEvents: [
        {
          type: "organize_planned_moves",
          message: organizePlanCopy(input.plan),
          data: {
            sourceDirectoryId: input.sourceDirectoryId,
            ...(input.plan.kind === "deterministic"
              ? {
                  moves: input.plan.moves.map((move) => ({
                    fileId: move.fileId,
                    fileName: move.fileName,
                    episodeCode: move.episodeCode,
                    seasonNumber: move.seasonNumber,
                    targetDirectoryId: move.targetDirectoryId,
                  })),
                }
              : {
                  moves: input.plan.moves.map((move) => ({
                    fileId: move.fileId,
                    fileName: move.fileName,
                    episodeCode: move.episodeCode,
                    seasonNumber: move.seasonNumber,
                    targetDirectoryId: move.targetDirectoryId,
                  })),
                  unresolved: input.plan.unresolved.map((entry) => ({
                    fileId: entry.fileId,
                    fileName: entry.fileName,
                    reason: entry.reason,
                    ...(entry.suggestedSeasonNumber === undefined
                      ? {}
                      : { suggestedSeasonNumber: entry.suggestedSeasonNumber }),
                    ...(entry.suggestedEpisodeCode === undefined
                      ? {}
                      : { suggestedEpisodeCode: entry.suggestedEpisodeCode }),
                  })),
                }),
          },
        },
      ],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions,
    transferAttempts: [],
    notifications: [],
  };
}

/** One-line summary of what a plan decided, for the run's audit trail. */
export function organizePlanCopy(plan: OrganizePlan): string {
  if (plan.kind === "deterministic") {
    return `整理计划：${plan.moves.length} 个文件可确定性放置`;
  }
  return `整理计划：${plan.moves.length} 个文件可放置，${plan.unresolved.length} 个需人工复核`;
}

/** Whether an organize run is something the user should see in their own activity. */
export function organizeIsUserVisible(): boolean {
  return true;
}
