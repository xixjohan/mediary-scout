import { connection, NextResponse, type NextRequest } from "next/server";
import {
  buildOrganizeRun,
  executeOrganizePlan,
  organizeDriftCopy,
  organizePlanCopy,
  organizeRunId,
  planOrganizeMoves,
  type OrganizePlan,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import type { TrackedSeasonState } from "@media-track/workflow";
import { buildAccountContextResolver, getWorkflowRepository } from "../../../../lib/workflow-runtime";

/**
 * POST /api/titles/organize — 自动整理 (batch 4).
 *
 * 整理 WRITES to the drive and the drive has no recycle bin, so this route is built
 * around the plan's guardrail: decide first, execute second, verify third, and never
 * report success that the drive did not confirm.
 *
 * Gates, in this order (the order is the design):
 *   1. scope      — no resolvable account ⇒ 401. Organizing moves files, so it may not
 *                   run unauthenticated.
 *   2. body       — tmdbId required and typed. The season is optional: absent means the
 *                   title's movies directory, which has no season.
 *   3. tracked    — the title must be tracked by THIS account. Fail closed.
 *   4. directory  — the season must actually have a storage directory. A season with
 *                   none has nothing to organize, and inventing one would write to a
 *                   guessed path.
 *
 * What it does NOT do: it does not pick a drive. 多盘归属 follows the workspace scope,
 * same as the import route — a drive selector here is how a file lands in the wrong
 * 115 account.
 *
 * The response never contains a drive URL, a share link, or an extract code. It
 * contains the *decisions*: which files can be placed, and for the rest, which file
 * failed to parse and what the suggestion was. That is what a `manual_review` has to
 * show the user, and it is the only part of this operation a browser should hold.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Parse and validate the request body. Split out of POST for the complexity budget. */
export function parseOrganizeRequestBody(
  value: unknown,
): { ok: true; tmdbId: number; seasonNumber?: number } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const body = value as { tmdbId?: unknown; seasonNumber?: unknown };
  const tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId must be a positive integer" };
  }
  if (body.seasonNumber === undefined) return { ok: true, tmdbId };
  const seasonNumber = typeof body.seasonNumber === "number" ? body.seasonNumber : Number.NaN;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) {
    return { ok: false, error: "seasonNumber must be a positive integer" };
  }
  return { ok: true, tmdbId, seasonNumber };
}

/**
 * Resolve what is being organized: the tracked title, its season, and the directory
 * the files are in. Split out of POST for the complexity budget — and because the
 * three gates it holds (tracked / season tracked / has a directory) are one decision
 * that a reader should be able to see whole.
 */
async function resolveOrganizeTarget(input: {
  accountId: string;
  tmdbId: number;
  seasonNumber: number | undefined;
}): Promise<
  | {
      ok: true;
      title: TrackedSeasonState["title"];
      season: TrackedSeasonState["season"];
      sourceDirectoryId: string;
      /** The account's connected storage, so the executor resolves per (account, drive). */
      connectedStorageId: TrackedSeasonState["connectedStorageId"];
    }
  | { ok: false; status: number; error: string }
> {
  const states = await getWorkflowRepository().listTrackedSeasonStates(input.accountId);
  const tracked = states.find((state) => state.title.tmdbId === input.tmdbId);
  if (!tracked) return { ok: false, status: 404, error: "title not tracked" };

  // An absent seasonNumber means the title's own (movies) directory. A named one must
  // match a season THIS account tracks — a season number that exists on some other
  // title is not a target.
  const season =
    input.seasonNumber === undefined || tracked.season?.seasonNumber === input.seasonNumber
      ? tracked.season
      : undefined;
  if (season === undefined) {
    return { ok: false, status: 404, error: "season not tracked" };
  }

  // No directory ⇒ nothing to organize, and no guessed path to write to.
  if (season.storageDirectoryId === undefined || season.storageDirectoryId.length === 0) {
    return { ok: false, status: 409, error: "season has no storage directory yet" };
  }
  return {
    ok: true,
    title: tracked.title,
    season,
    sourceDirectoryId: season.storageDirectoryId,
    connectedStorageId: tracked.connectedStorageId,
  };
}

/** The file list a `manual_review` sends back, with no drive URLs in it.
 *
 *  Only ever called with the review variant — taking the narrowed type rather than
 *  re-checking `kind` inside is what keeps this a data mapper and not a second
 *  decision point. */
function reviewPayload(plan: Extract<OrganizePlan, { kind: "manual_review" }>) {
  return {
    copy: organizePlanCopy(plan),
    review: {
      placeable: plan.moves.map((move) => ({
        fileId: move.fileId,
        fileName: move.fileName,
        episodeCode: move.episodeCode,
        seasonNumber: move.seasonNumber,
      })),
      unresolved: plan.unresolved.map((entry) => ({
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
    },
  };
}

export async function POST(request: NextRequest) {
  await connection();

  // 1) Scope, fail-closed.
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  // 2) Body.
  let parsed: ReturnType<typeof parseOrganizeRequestBody>;
  try {
    parsed = parseOrganizeRequestBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }
  const { tmdbId, seasonNumber } = parsed;

  // 3)+4) Tracked, season tracked, and a directory to read — no guessed path.
  const target = await resolveOrganizeTarget({ accountId, tmdbId, seasonNumber });
  if (!target.ok) {
    return NextResponse.json({ error: target.error }, { status: target.status, headers: NO_STORE });
  }
  const { title, season, sourceDirectoryId, connectedStorageId } = target;

  // Scope-following: the account's own connected storage, never a caller-named drive.
  // Passing the TMDB id here (an easy slip — both are numbers on the title) would
  // resolve storage for a drive that does not exist and silently fall back.
  const storage = (await buildAccountContextResolver()(accountId, connectedStorageId))?.storage;
  if (storage === null || storage === undefined) {
    return NextResponse.json({ error: "storage unavailable" }, { status: 409, headers: NO_STORE });
  }

  const files = await storage.listVideoFiles(sourceDirectoryId);

  // The season this run may write into. Exactly one entry ⇒ a season-only file name is
  // unambiguous; anything else ⇒ a human, never a guess. A movie (no season) has no
  // episode codes to parse, so it is a review from the start rather than a silent move.
  const targetSeasons = season === undefined ? [] : [season.seasonNumber];
  const plan: OrganizePlan =
    targetSeasons.length === 0
      ? { kind: "manual_review", moves: [], unresolved: [] }
      : planOrganizeMoves({
          files: files.map((file) => ({ fileId: file.id, fileName: file.name })),
          targetSeasons,
          resolveTargetDirectory: () => sourceDirectoryId,
        });

  const run = buildOrganizeRun({
    title: title as unknown as Parameters<typeof buildOrganizeRun>[0]["title"],
    season: season as unknown as Parameters<typeof buildOrganizeRun>[0]["season"],
    sourceDirectoryId,
    plan,
    accountId,
    connectedStorageId,
    now: new Date().toISOString(),
  });
  const runId = organizeRunId(title.id, season.seasonNumber);

  if (plan.kind !== "deterministic") {
    // Nothing was touched. Persist the review so the user can see what was ambiguous.
    await getWorkflowRepository().saveWorkflowRunSnapshot(run);
    return NextResponse.json(
      { status: "manual_review", ...reviewPayload(plan) },
      { status: 200, headers: NO_STORE },
    );
  }

  // Deterministic: execute with the guardrail. The plan is on the run BEFORE the first
  // move, and the result is compared against a re-read of the drive.
  const execution = await executeOrganizePlan({
    storage,
    plan,
    persist: async (event) => {
      const existing = await getWorkflowRepository().getWorkflowRunSnapshot(runId, accountId);
      await getWorkflowRepository().saveWorkflowRunSnapshot({
        ...run,
        workflowRun: {
          ...run.workflowRun,
          auditEvents: [...(existing?.workflowRun.auditEvents ?? []), event],
        },
      });
    },
  });

  if (execution.status !== "organized") {
    // Drift or failure: 409, never 200. The drive did not confirm what was planned.
    await getWorkflowRepository().saveWorkflowRunSnapshot(run);
    return NextResponse.json(
      {
        status: execution.status,
        copy:
          execution.status === "drift"
            ? organizeDriftCopy(execution.drift)
            : execution.status === "failed"
              ? execution.error
              : organizePlanCopy(plan),
      },
      { status: 409, headers: NO_STORE },
    );
  }

  await getWorkflowRepository().saveWorkflowRunSnapshot(run);
  return NextResponse.json(
    {
      status: "organized",
      copy: organizePlanCopy(plan),
      moves: plan.moves.map((move) => ({
        fileId: move.fileId,
        fileName: move.fileName,
        episodeCode: move.episodeCode,
        seasonNumber: move.seasonNumber,
      })),
    },
    { status: 200, headers: NO_STORE },
  );
}
