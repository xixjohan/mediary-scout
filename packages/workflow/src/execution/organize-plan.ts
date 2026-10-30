import { episodeCodeFromFileName, episodeCodeNamesSeason } from "../domain/episode-code.js";

/**
 * Batch 4: the planned-moves guardrail for 自动整理 (plan §3.4 / §3.6).
 *
 * 整理 is destructive and the drive has no recycle bin, so the plan's mandatory
 * guardrail is: **compute the target paths first, write them into the run, execute,
 * then compare what actually happened against what was planned — any drift stops the
 * run and is reported to a human.** (Borrowed from MP's `target-path` preview →
 * `transfer/manual` execute split.)
 *
 * This module is the *decision* half: which files can be placed with certainty (L1),
 * which must go to a human (L2), and whether an execution matched its plan. It does
 * no drive I/O — the caller passes the files in and the target directory out, so the
 * whole thing is testable without a drive and, more importantly, so the plan that gets
 * persisted is exactly the plan that was reasoned about.
 *
 * The three levels from the plan, as one type:
 *
 *   L1 确定性     every file yields a unique episode code AND a unique target season
 *                ⇒ `deterministic`, place without a human
 *   L2 人工复核   any file fails to parse, or the season is not unique, or two files
 *                claim the same episode ⇒ `manual_review`, front end lists the files
 *                and the suggested targets
 *   L3 agent     not decided here — the plan makes it an explicit opt-in on the
 *                organize panel, so it is a caller-side choice, never a fallback
 *                reached by this function giving up.
 */

/** One file the caller found in the directory being organized. */
export interface OrganizeInputFile {
  fileId: string;
  fileName: string;
}

/** A decided placement: this file goes to that directory as that episode. */
export interface OrganizeMove {
  fileId: string;
  fileName: string;
  /** `SxxExx`, as produced by `episodeCodeFromFileName`. */
  episodeCode: string;
  seasonNumber: number;
  targetDirectoryId: string;
}

/** A file this refuses to place. `reason` is what the front end shows the user. */
export interface UnresolvedOrganizeFile {
  fileId: string;
  fileName: string;
  reason: UnresolvedOrganizeReason;
  /** Best-effort suggestion for the human, when there is one. Never acted on. */
  suggestedSeasonNumber?: number;
  suggestedEpisodeCode?: string;
}

export type UnresolvedOrganizeReason =
  /** `episodeCodeFromFileName` returned null — the name carries no episode code. */
  | "no_episode_code"
  /** A season-only name (第 N 集) and the target season is not the only candidate. */
  | "ambiguous_season"
  /** Two files in the same package claim the same episode. */
  | "duplicate_episode_code";

export type OrganizePlan =
  | { kind: "deterministic"; moves: OrganizeMove[] }
  | {
      kind: "manual_review";
      /** The files that CAN be placed — the front end shows them as pre-filled. */
      moves: OrganizeMove[];
      /** The files it will not place, and why. */
      unresolved: UnresolvedOrganizeFile[];
    };

/**
 * The season number an episode code names, **as written in the code**.
 *
 * Note this is the code's own claim, not a fact about the file: a bare 第N集 is
 * normalized upstream to `S01Enn`, so this returns 1 for a file that never mentioned
 * a season. Callers that care must ask `episodeCodeNamesSeason(fileName)` instead —
 * acting on the code's season for such a file is how a package gets filed into the
 * wrong season.
 */
export function seasonNumberFromEpisodeCode(episodeCode: string): number | null {
  const match = /^S(\d{1,2})E\d{1,4}$/.exec(episodeCode);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Decide how a package organizes.
 *
 * `targetSeasons` is the set of seasons this run is willing to write into. A file
 * naming its own season outside that set is unresolved (`ambiguous_season`) rather
 * than silently placed — the plan is explicit that a cross-season package goes to a
 * human, not that it gets split.
 *
 * `resolveTargetDirectory` is injected rather than reached for: the target id comes
 * from the drive (find-or-create under the show dir), and keeping it out is what lets
 * this run without one.
 */
export function planOrganizeMoves(input: {
  files: readonly OrganizeInputFile[];
  /** Seasons this run may write into. One entry ⇒ a season-only name is unambiguous. */
  targetSeasons: readonly number[];
  resolveTargetDirectory: (seasonNumber: number) => string;
}): OrganizePlan {
  const moves: OrganizeMove[] = [];
  const unresolved: UnresolvedOrganizeFile[] = [];
  const seen = new Map<string, string>();

  for (const file of input.files) {
    const episodeCode = episodeCodeFromFileName(file.fileName);
    if (episodeCode === null) {
      unresolved.push({ fileId: file.fileId, fileName: file.fileName, reason: "no_episode_code" });
      continue;
    }

    const resolved = resolveOrganizeSeason({
      fileName: file.fileName,
      episodeCode,
      targetSeasons: input.targetSeasons,
    });
    if (resolved.kind !== "ok") {
      unresolved.push({
        fileId: file.fileId,
        fileName: file.fileName,
        reason: "ambiguous_season",
        ...(resolved.suggestedSeasonNumber === undefined
          ? {}
          : { suggestedSeasonNumber: resolved.suggestedSeasonNumber }),
        suggestedEpisodeCode: episodeCode,
      });
      continue;
    }
    const seasonNumber = resolved.seasonNumber;
    const finalEpisodeCode = resolved.episodeCode;

    const clash = seen.get(episodeCode);
    if (clash !== undefined) {
      unresolved.push({
        fileId: file.fileId,
        fileName: file.fileName,
        reason: "duplicate_episode_code",
        suggestedSeasonNumber: seasonNumber,
        suggestedEpisodeCode: episodeCode,
      });
      continue;
    }
    seen.set(episodeCode, file.fileId);

    moves.push({
      fileId: file.fileId,
      fileName: file.fileName,
      episodeCode: finalEpisodeCode,
      seasonNumber,
      targetDirectoryId: input.resolveTargetDirectory(seasonNumber),
    });
  }

  return unresolved.length === 0
    ? { kind: "deterministic", moves }
    : { kind: "manual_review", moves, unresolved };
}

/** What actually happened to a file, as read back from the drive after the moves. */
export interface ActualPlacement {
  fileId: string;
  directoryId: string;
}

export type OrganizeDrift =
  | { kind: "match" }
  /** Planned, never happened. */
  | { kind: "missing"; moves: OrganizeMove[] }
  /** Happened, never planned. */
  | { kind: "unexpected"; fileIds: string[] }
  /** Happened, but landed somewhere other than the planned directory. */
  | { kind: "wrong_target"; moves: WrongTargetMove[] };

export interface WrongTargetMove {
  move: OrganizeMove;
  actualDirectoryId: string;
}

/**
 * Compare an execution against its plan. This is the other half of the guardrail:
 * a run whose result does not match what was written down must stop and be reported,
 * not quietly declared done.
 *
 * Missing and wrong-target are both "the file is not where we said it would be", and
 * both are reported together with the full detail — a partial drift is the case where
 * stopping matters most, because everything else already moved.
 */
export function comparePlannedVsActual(
  planned: readonly OrganizeMove[],
  actual: readonly ActualPlacement[],
): OrganizeDrift {
  const actualById = new Map(actual.map((entry) => [entry.fileId, entry.directoryId]));
  const plannedIds = new Set(planned.map((move) => move.fileId));

  const missing: OrganizeMove[] = [];
  const wrongTarget: WrongTargetMove[] = [];
  for (const move of planned) {
    const landed = actualById.get(move.fileId);
    if (landed === undefined) {
      missing.push(move);
      continue;
    }
    if (landed !== move.targetDirectoryId) {
      wrongTarget.push({ move, actualDirectoryId: landed });
    }
  }

  const unexpected = actual
    .filter((entry) => !plannedIds.has(entry.fileId))
    .map((entry) => entry.fileId);

  if (missing.length > 0) return { kind: "missing", moves: missing };
  if (wrongTarget.length > 0) return { kind: "wrong_target", moves: wrongTarget };
  if (unexpected.length > 0) return { kind: "unexpected", fileIds: unexpected };
  return { kind: "match" };
}

/**
 * Which season a file goes to, and the episode code it goes by.
 *
 * Two very different situations, kept apart on purpose:
 *
 *   · The file names its season (`SxxEyy`). That is a fact about the file. If the
 *     season is one this run writes into, place it there; otherwise it is unresolved —
 *     guessing a neighbouring season is how a package ends up split across shelves.
 *
 *   · The file does not (a bare 第N集). The code's `S01` is an upstream assumption,
 *     trustworthy only for season 1. So the target season must be **unique** — the
 *     caller said which season this package is for — and the episode code is rebuilt
 *     with that season, so what gets persisted never claims a season the file denied.
 */
function resolveOrganizeSeason(input: {
  fileName: string;
  episodeCode: string;
  targetSeasons: readonly number[];
}):
  | { kind: "ok"; seasonNumber: number; episodeCode: string }
  | { kind: "ambiguous"; suggestedSeasonNumber?: number } {
  const episodeNumberMatch = /^S\d{1,2}E(\d{1,4})$/.exec(input.episodeCode);
  const episodeNumber = episodeNumberMatch?.[1];
  if (episodeNumber === undefined) {
    // Not a shape we understand; refuse rather than guess.
    return { kind: "ambiguous" };
  }

  if (episodeCodeNamesSeason(input.fileName)) {
    const named = seasonNumberFromEpisodeCode(input.episodeCode);
    if (named === null) return { kind: "ambiguous" };
    if (!input.targetSeasons.includes(named)) {
      return { kind: "ambiguous", suggestedSeasonNumber: named };
    }
    return { kind: "ok", seasonNumber: named, episodeCode: input.episodeCode };
  }

  if (input.targetSeasons.length !== 1) {
    return { kind: "ambiguous" };
  }
  const seasonNumber = input.targetSeasons[0]!;
  return {
    kind: "ok",
    seasonNumber,
    // Re-stamp the season the caller chose: the file never named one, so the
    // persisted code must not keep claiming the upstream default.
    episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${episodeNumber}`,
  };
}
