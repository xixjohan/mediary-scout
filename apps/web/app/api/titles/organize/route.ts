import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import type { TrackedSeasonState } from "@media-track/workflow";
import { buildAccountContextResolver, getWorkflowRepository } from "../../../../lib/workflow-runtime";
import {
  NO_STORE,
  handleMovieOrganize,
  handleTvOrganize,
  handleLegacyTvOrganize,
} from "./organize-handlers";

/**
 * POST /api/titles/organize — 自动整理 (batch 4).
 */

/** Parse and validate the request body. Split out of POST for the complexity budget. */
export function parseOrganizeRequestBody(
  value: unknown,
): { ok: true; tmdbId: number; seasonNumber?: number; directoryId?: string } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const body = value as { tmdbId?: unknown; seasonNumber?: unknown; directoryId?: unknown };
  const tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId must be a positive integer" };
  }
  const directoryId =
    typeof body.directoryId === "string" && body.directoryId.trim().length > 0
      ? body.directoryId.trim()
      : undefined;

  const result: { ok: true; tmdbId: number; seasonNumber?: number; directoryId?: string } = {
    ok: true,
    tmdbId,
  };
  if (directoryId !== undefined) {
    result.directoryId = directoryId;
  }

  if (body.seasonNumber === undefined) return result;

  const seasonNumber = typeof body.seasonNumber === "number" ? body.seasonNumber : Number.NaN;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) {
    return { ok: false, error: "seasonNumber must be a positive integer" };
  }
  result.seasonNumber = seasonNumber;
  return result;
}

/**
 * Resolve what is being organized: the tracked title, its season, and the directory
 * the files are in.
 */
async function resolveOrganizeTarget(input: {
  accountId: string;
  tmdbId: number;
  seasonNumber: number | undefined;
  directoryId?: string | undefined;
}): Promise<
  | {
      ok: true;
      title: TrackedSeasonState["title"];
      season: TrackedSeasonState["season"];
      sourceDirectoryId: string;
      connectedStorageId: TrackedSeasonState["connectedStorageId"];
    }
  | { ok: false; status: number; error: string }
> {
  const states = await getWorkflowRepository().listTrackedSeasonStates(input.accountId);
  const matchedStates = states.filter((state) => state.title.tmdbId === input.tmdbId);
  if (matchedStates.length === 0) return { ok: false, status: 404, error: "title not tracked" };

  let tracked = matchedStates.find((state) =>
    input.seasonNumber !== undefined ? state.season?.seasonNumber === input.seasonNumber : true,
  );
  if (!tracked) {
    tracked = matchedStates[0]!;
  }

  const season = tracked.season;

  const effectiveDirectoryId = input.directoryId ?? season.storageDirectoryId;
  if (effectiveDirectoryId === undefined || effectiveDirectoryId.length === 0) {
    return { ok: false, status: 409, error: "season has no storage directory yet" };
  }
  return {
    ok: true,
    title: tracked.title,
    season,
    sourceDirectoryId: effectiveDirectoryId,
    connectedStorageId: tracked.connectedStorageId,
  };
}

async function resolveOrganizeContext(request: NextRequest) {
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return { errorResponse: accountId };

  let parsed: ReturnType<typeof parseOrganizeRequestBody>;
  try {
    parsed = parseOrganizeRequestBody(await request.json());
  } catch {
    return {
      errorResponse: NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE }),
    };
  }
  if (!parsed.ok) {
    return {
      errorResponse: NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE }),
    };
  }
  const { tmdbId, seasonNumber, directoryId } = parsed;

  const target = await resolveOrganizeTarget({ accountId, tmdbId, seasonNumber, directoryId });
  if (!target.ok) {
    return {
      errorResponse: NextResponse.json({ error: target.error }, { status: target.status, headers: NO_STORE }),
    };
  }

  const accountContext = await buildAccountContextResolver()(accountId, target.connectedStorageId);
  const storage = accountContext?.storage;
  if (!storage) {
    return {
      errorResponse: NextResponse.json({ error: "storage unavailable" }, { status: 409, headers: NO_STORE }),
    };
  }

  return { accountId, target, accountContext, storage };
}

export async function POST(request: NextRequest) {
  await connection();
  const ctx = await resolveOrganizeContext(request);
  if ("errorResponse" in ctx) return ctx.errorResponse;
  const { accountId, target, accountContext, storage } = ctx;
  const { title, season, sourceDirectoryId, connectedStorageId } = target;

  if (title.type === "movie") {
    return handleMovieOrganize({
      storage,
      title,
      sourceDirectoryId,
      connectedStorageId,
      moviesParentDirectoryId: accountContext?.moviesParentDirectoryId,
      season,
      accountId,
    });
  }

  if (title.type === "tv" || title.type === "anime") {
    const tvParentDir =
      title.type === "anime"
        ? (accountContext?.animeStorageParentDirectoryId ?? accountContext?.storageParentDirectoryId)
        : accountContext?.storageParentDirectoryId;

    return handleTvOrganize({
      storage,
      title,
      sourceDirectoryId,
      connectedStorageId,
      tvParentDirectoryId: tvParentDir,
      season,
      accountId,
      currentSeasonNumber: season?.seasonNumber,
    });
  }

  return handleLegacyTvOrganize({
    storage,
    title,
    season,
    sourceDirectoryId,
    accountId,
    connectedStorageId,
  });
}
