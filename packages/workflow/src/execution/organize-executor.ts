import type { AuditEvent, VerifiedFile } from "../domain/domain.js";
import type { StorageExecutor } from "../domain/ports.js";
import type { WorkflowRepository } from "../persistence/repository.js";
import {
  comparePlannedVsActual,
  type ActualPlacement,
  type OrganizeDrift,
  type OrganizeMove,
  type OrganizePlan,
} from "./organize-plan.js";

/**
 * Batch 4: the execution half of 自动整理, and the other side of the plan's
 * mandatory guardrail.
 *
 * 整理 moves files on a drive with no recycle bin. The plan's rule is explicit:
 * **write the planned moves into the run BEFORE executing, then compare what
 * actually happened, and on any drift stop and report to a human.**
 *
 * The order here is the design:
 *
 *   1. A `manual_review` plan touches nothing. Not "moves what it can" — the
 *      unresolved files are the reason it is in review, and a partial move would
 *      leave the drive in a state nobody chose.
 *   2. The plan is persisted as an audit event BEFORE the first `moveFiles`. A run
 *      that crashes mid-way must leave behind what it intended, or the drift check
 *      after a restart has nothing to compare against.
 *   3. Moves are executed one file at a time. A batch call that half-succeeds gives
 *      no per-file answer, and per-file answers are what the comparison needs.
 *   4. The result is read back from the drive, not from the move call's return.
 *      The plan is explicit that truth is a re-read, not an acknowledgement.
 *   5. Drift stops the run. It does not retry, and it does not report success.
 */

export const ORGANIZE_PLANNED_EVENT = "organize_planned_moves";
export const ORGANIZE_DRIFT_EVENT = "organize_drift";

export type OrganizeExecutionResult =
  | { status: "organized"; moves: OrganizeMove[] }
  | { status: "manual_review"; unresolvedCount: number }
  | { status: "drift"; drift: OrganizeDrift }
  | { status: "failed"; error: string };

/** Serialize a plan into the run's audit trail, before anything moves. */
export function recordPlannedMoves(moves: readonly OrganizeMove[]): AuditEvent {
  return {
    type: ORGANIZE_PLANNED_EVENT,
    message: `整理计划：${moves.length} 个文件`,
    data: {
      moves: moves.map((move) => ({
        fileId: move.fileId,
        fileName: move.fileName,
        episodeCode: move.episodeCode,
        seasonNumber: move.seasonNumber,
        targetDirectoryId: move.targetDirectoryId,
      })),
    },
  };
}

/** Serialize a drift into the audit trail, so a human can see exactly what diverged. */
export function recordOrganizeDrift(drift: OrganizeDrift): AuditEvent {
  return {
    type: ORGANIZE_DRIFT_EVENT,
    message: organizeDriftCopy(drift),
    data: { drift } as unknown as Record<string, unknown>,
  };
}

/**
 * Read the planned moves back out of a run's audit trail.
 *
 * Validating on the way in is what makes this worth calling rather than casting:
 * the data crossed a SQLite boundary, and a run whose plan was written by an older
 * shape must come back as "no plan" rather than as a plan with holes in it.
 */
export function plannedMovesFromRun(auditEvents: readonly AuditEvent[]): OrganizeMove[] {
  for (let index = auditEvents.length - 1; index >= 0; index -= 1) {
    const event = auditEvents[index];
    if (event?.type !== ORGANIZE_PLANNED_EVENT) continue;
    const raw = event.data?.["moves"];
    if (!Array.isArray(raw)) return [];
    const moves: OrganizeMove[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) return [];
      const move = entry as Record<string, unknown>;
      if (
        typeof move["fileId"] !== "string" ||
        typeof move["fileName"] !== "string" ||
        typeof move["episodeCode"] !== "string" ||
        typeof move["seasonNumber"] !== "number" ||
        typeof move["targetDirectoryId"] !== "string"
      ) {
        // A hole in the plan is not a plan. Bail out entirely rather than execute
        // the part that parsed.
        return [];
      }
      moves.push({
        fileId: move["fileId"] as string,
        fileName: move["fileName"] as string,
        episodeCode: move["episodeCode"] as string,
        seasonNumber: move["seasonNumber"] as number,
        targetDirectoryId: move["targetDirectoryId"] as string,
      });
    }
    return moves;
  }
  return [];
}

/** Human-readable drift copy. Written for the person who has to go fix the drive. */
export function organizeDriftCopy(drift: OrganizeDrift): string {
  switch (drift.kind) {
    case "match":
      return "整理结果与计划一致";
    case "missing":
      return `整理中断：${drift.moves.length} 个文件没有搬到目标目录（${drift.moves
        .map((move) => move.fileName)
        .join("、")}）`;
    case "unexpected":
      return `整理结果异常：出现了计划之外的 ${drift.fileIds.length} 个文件`;
    case "wrong_target":
      return `整理放错位置：${drift.moves.length} 个文件没有落在计划目录（${drift.moves
        .map((entry) => entry.move.fileName)
        .join("、")}）`;
  }
}

/**
 * Read back where the planned files actually are, across every directory the plan
 * writes into. The guardrail compares against a re-read of the drive, not against
 * what the move call claimed.
 *
 * Attribution is cross-directory on purpose: a file that landed in a *different*
 * planned directory is a `wrong_target` drift, and that is only visible if every
 * planned directory is searched for every planned file. Looking for each file only
 * in its own target would report the same situation as `missing` — still a stop, but
 * with a diagnosis that sends the human to the wrong place.
 *
 * The honest boundary: a file that ended up somewhere the plan never mentions is
 * reported as `missing`, not `wrong_target`, because finding it would mean searching
 * the whole drive. Both stop the run; only the copy differs.
 */
async function readBackPlacements(
  storage: StorageExecutor,
  moves: readonly OrganizeMove[],
): Promise<ActualPlacement[]> {
  const plannedDirectories = [...new Set(moves.map((move) => move.targetDirectoryId))];
  const plannedFileIds = new Set(moves.map((move) => move.fileId));
  const foundIn = new Map<string, Set<string>>();

  for (const directoryId of plannedDirectories) {
    const files: VerifiedFile[] = await storage.listVideoFiles(directoryId);
    for (const file of files) {
      if (!plannedFileIds.has(file.id)) continue;
      const dirs = foundIn.get(file.id);
      if (dirs === undefined) {
        foundIn.set(file.id, new Set([directoryId]));
      } else {
        dirs.add(directoryId);
      }
    }
  }

  // Match on the drive's own file identity. A name match would be fooled by the
  // canonical rename that a later step performs, and by two files that share a name.
  const placements: ActualPlacement[] = [];
  for (const move of moves) {
    const dirs = foundIn.get(move.fileId);
    if (dirs === undefined || dirs.size === 0) continue;
    // Seen in its own directory ⇒ placed as planned. Seen elsewhere (or in several)
    // ⇒ report the first such directory so the drift names where it really is.
    if (dirs.has(move.targetDirectoryId)) {
      placements.push({ fileId: move.fileId, directoryId: move.targetDirectoryId });
      continue;
    }
    placements.push({ fileId: move.fileId, directoryId: [...dirs][0]! });
  }
  return placements;
}

/**
 * Execute a plan, then verify it against the drive.
 *
 * `persist` is injected rather than reached for so the caller decides what "write
 * this into the run" means for its repository — and so this function can be tested
 * without a workflow repository at all.
 */
export async function executeOrganizePlan(input: {
  storage: StorageExecutor;
  plan: OrganizePlan;
  /** Called with the planned-moves event BEFORE the first move, and with a drift
   *  event when the comparison fails. */
  persist: (event: AuditEvent) => Promise<void>;
}): Promise<OrganizeExecutionResult> {
  if (input.plan.kind !== "deterministic") {
    // Nothing is touched. See the header: a partial move is a state nobody chose.
    return { status: "manual_review", unresolvedCount: input.plan.unresolved.length };
  }
  const moves = input.plan.moves;

  // (2) The plan is on record before anything moves.
  await input.persist(recordPlannedMoves(moves));

  // (3) One file per call, so a failure names the file.
  for (const move of moves) {
    await input.storage.moveFiles({ fileIds: [move.fileId], targetDirectoryId: move.targetDirectoryId });
  }

  // (4)+(5) Re-read the drive and compare.
  let actual: ActualPlacement[];
  try {
    actual = await readBackPlacements(input.storage, moves);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const drift = comparePlannedVsActual(moves, actual);
  if (drift.kind !== "match") {
    // Stop and report. No retry: a second attempt on a drive whose moves did not
    // land as planned is how a half-moved package gets moved twice.
    await input.persist(recordOrganizeDrift(drift));
    return { status: "drift", drift };
  }
  return { status: "organized", moves };
}

/** Convenience for the worker: turn an execution result into the run's next status. */
export function organizeRunStatus(
  result: OrganizeExecutionResult,
): "succeeded" | "manual_review" | "failed" {
  switch (result.status) {
    case "organized":
      return "succeeded";
    case "manual_review":
      return "manual_review";
    case "drift":
    case "failed":
      return "failed";
  }
}
