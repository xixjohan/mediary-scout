import { connection, NextResponse, type NextRequest } from "next/server";
import {
  resolveTitleResources,
  buildTitleSearchKeywords,
  buildResourceSearchRun,
  movieAnchorSeason,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import {
  getWorkflowRepository,
  getWorkerResourceProvider,
  movieTargetFromTmdbId,
} from "../../../../lib/workflow-runtime";
import { seriesTargetFor } from "../../../../lib/title-hub";
import { resourceCache, resourceLimiter } from "./cache";

/**
 * POST /api/titles/resources — resource search (W2, batch 2 + enhancements).
 *
 * Supports searching resources for both tracked titles and untracked titles
 * viewed from the search results page. Supports custom keywords, specific seasons,
 * and specific episodes via the SearchKeywordStrategy.
 *
 * Gates:
 *   1. scope    — no resolvable account ⇒ 401
 *   2. cooldown — 60s per (account, title) ⇒ 429 + Retry-After
 *   3. TTL      — 30 min per (account, title, queryKey) ⇒ cached candidates
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ParsedResourceRequest {
  tmdbId: number;
  customKeyword?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  typeHint?: "movie" | "tv" | "anime";
}

function parsePositiveInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val > 0 ? val : undefined;
}

function parseOptionalString(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTypeHint(val: unknown): "movie" | "tv" | "anime" | undefined {
  if (val === "movie" || val === "tv" || val === "anime") return val;
  return undefined;
}

async function parseRequestBody(request: NextRequest): Promise<ParsedResourceRequest | NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }

  const tmdbId = typeof body["tmdbId"] === "number" ? body["tmdbId"] : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400, headers: NO_STORE });
  }

  return {
    tmdbId,
    customKeyword: parseOptionalString(body["customKeyword"]),
    seasonNumber: parsePositiveInt(body["seasonNumber"]),
    episodeNumber: parsePositiveInt(body["episodeNumber"]),
    typeHint: parseTypeHint(body["type"]),
  };
}

interface ResolvedTitleContext {
  title: MediaTitle;
  season: TrackedSeason;
  connectedStorageId: string | null;
}

function buildSyntheticSeason(title: MediaTitle, seasonNumber?: number, target?: unknown): TrackedSeason {
  if (title.type === "movie") {
    return movieAnchorSeason({
      titleId: title.id,
      qualityPreference: "4K",
      storageDirectoryId: "",
    });
  }
  const sNum = seasonNumber ?? 1;
  const targetSeasons =
    target && typeof target === "object" && "seasons" in target && Array.isArray(target.seasons)
      ? target.seasons
      : [];
  const targetSeason = targetSeasons.find(
    (s) => typeof s === "object" && s !== null && "seasonNumber" in s && s.seasonNumber === sNum,
  ) as { totalEpisodes?: number; latestAiredEpisode?: number } | undefined;

  return {
    id: `${title.id}_s${sNum}`,
    mediaTitleId: title.id,
    seasonNumber: sNum,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: targetSeason?.totalEpisodes ?? 1,
    latestAiredEpisode: targetSeason?.latestAiredEpisode ?? 1,
    latestAiredSource: "metadata",
  };
}

async function resolveTitleContext(
  accountId: string,
  tmdbId: number,
  typeHint?: "movie" | "tv" | "anime",
  seasonNumber?: number,
): Promise<ResolvedTitleContext | null> {
  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const tracked = states.find((state) => state.title.tmdbId === tmdbId);
  if (tracked) {
    return {
      title: tracked.title,
      season: tracked.season,
      connectedStorageId: tracked.connectedStorageId,
    };
  }

  if (typeHint === "movie") {
    const movieTarget = await movieTargetFromTmdbId(tmdbId);
    if (!movieTarget) return null;
    return {
      title: movieTarget.title,
      season: buildSyntheticSeason(movieTarget.title),
      connectedStorageId: null,
    };
  }

  const target = (await seriesTargetFor(tmdbId)) ?? (await movieTargetFromTmdbId(tmdbId));
  if (!target) return null;
  return {
    title: target.title,
    season: buildSyntheticSeason(target.title, seasonNumber, target),
    connectedStorageId: null,
  };
}

async function handleResourceResult(
  result: TitleResourceResult,
  context: {
    accountId: string;
    tmdbId: number;
    title: MediaTitle;
    season: TrackedSeason;
    connectedStorageId: string | null;
  },
): Promise<NextResponse> {
  if (result.kind === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (result.kind === "throttled") {
    return NextResponse.json(
      { error: "too many requests", retryAfterMs: result.retryAfterMs },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) } },
    );
  }
  if (result.kind === "error") {
    return NextResponse.json({ error: "search failed", detail: result.message }, { status: 502, headers: NO_STORE });
  }

  if (result.snapshot !== null) {
    try {
      await getWorkflowRepository().saveWorkflowRunSnapshot(
        buildResourceSearchRun({
          snapshot: result.snapshot,
          title: context.title,
          season: context.season,
          accountId: context.accountId,
          connectedStorageId: context.connectedStorageId,
          now: result.snapshot.createdAt,
        }),
      );
    } catch (error) {
      console.error("[titles/resources] snapshot persist failed", error);
    }
  }

  return NextResponse.json(
    {
      tmdbId: context.tmdbId,
      cached: result.cached,
      count: result.candidates.length,
      candidates: result.candidates,
      ...(result.snapshot === null ? {} : { snapshotId: result.snapshot.id }),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: NextRequest) {
  await connection();

  // 1) Scope, fail-closed.
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  const parsed = await parseRequestBody(request);
  if (parsed instanceof Response) return parsed;
  const { tmdbId, customKeyword, seasonNumber, episodeNumber, typeHint } = parsed;

  // 2) Resolve title and season
  const resolved = await resolveTitleContext(accountId, tmdbId, typeHint, seasonNumber);
  if (!resolved) {
    return NextResponse.json({ error: "title not found" }, { status: 404, headers: NO_STORE });
  }
  const { title, season, connectedStorageId } = resolved;

  // Look up subscription policy custom keywords if configured
  const policy = await getWorkflowRepository().getSubscriptionPolicy({
    accountId,
    titleKey: title.id,
  });

  const keywords = buildTitleSearchKeywords(title, {
    customKeyword,
    customKeywords: policy?.customKeywords,
    seasonNumber,
    episodeNumber,
  }).map((entry) => entry.keyword);

  const cacheKeyParts = [
    customKeyword ?? "",
    seasonNumber ? `s${seasonNumber}` : "",
    episodeNumber ? `e${episodeNumber}` : "",
  ].filter(Boolean);
  const cacheKeySuffix = cacheKeyParts.length > 0 ? cacheKeyParts.join(":") : undefined;

  const provider = await getWorkerResourceProvider();
  const result = await resolveTitleResources({
    accountId,
    titleId: String(tmdbId),
    keywords,
    search: ({ keyword }) => provider.search({ keyword }),
    cache: resourceCache,
    limiter: resourceLimiter,
    loadCachedCandidates: async () => [],
    ...(cacheKeySuffix ? { cacheKeySuffix } : {}),
  });

  return handleResourceResult(result, {
    accountId,
    tmdbId,
    title,
    season,
    connectedStorageId,
  });
}
