import {
  buildTitleId,
  createTmdbMetadataProvider,
  prepareSeriesTarget,
  type DurableJsonCache,
  type MediaTitle,
  type PreparedSeriesTarget,
} from "@media-track/workflow";
import { isLiveSearch } from "./search-provider";
import { findDemoCandidateByTmdbId } from "./demo-candidates";
import { createTtlMemo } from "./series-target-memo";
import { getDurableJsonCache } from "./durable-cache";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getTmdbAccesses,
} from "./workflow-runtime";

const SERIES_TARGET_TTL_MS = 6 * 60 * 60 * 1000;
const SERIES_TARGET_MISS_TTL_MS = 60_000;

let durableTargetCache: DurableJsonCache | null = null;
function getDurableTargetCache(): DurableJsonCache {
  if (durableTargetCache) return durableTargetCache;
  durableTargetCache = getDurableJsonCache();
  return durableTargetCache;
}

export async function loadSeriesTargetWithCache(
  tmdbId: number,
  durable: DurableJsonCache,
  fetchTarget: (tmdbId: number) => Promise<PreparedSeriesTarget | null>,
): Promise<PreparedSeriesTarget | null> {
  const fromDb = await durable.getJson<PreparedSeriesTarget>(`series-target:${tmdbId}`);
  if (fromDb) return fromDb;
  let value: PreparedSeriesTarget | null;
  try {
    value = await fetchTarget(tmdbId);
  } catch {
    return null;
  }
  try {
    await durable.setJson(`series-target:${tmdbId}`, value, SERIES_TARGET_TTL_MS);
  } catch (error) {
    console.error(
      `[media-track] series-target cache write failed for ${tmdbId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

async function loadSeriesTarget(tmdbId: number): Promise<PreparedSeriesTarget | null> {
  return loadSeriesTargetWithCache(tmdbId, getDurableTargetCache(), async (id) =>
    prepareSeriesTarget({
      tmdbId: id,
      qualityPreference: "4K",
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
    }),
  );
}

const seriesTargetMemo = createTtlMemo<PreparedSeriesTarget>({
  successTtlMs: SERIES_TARGET_TTL_MS,
  failureTtlMs: SERIES_TARGET_MISS_TTL_MS,
  load: loadSeriesTarget,
});

export async function seriesTargetFor(tmdbId: number): Promise<PreparedSeriesTarget | null> {
  if (isLiveSearch()) {
    return seriesTargetMemo(tmdbId);
  }

  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  const title: MediaTitle = {
    id: buildTitleId({ source: "tmdb", mediaKind: "tv", id: candidate.tmdbId }),
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title
        ? [candidate.originalTitle]
        : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return {
    title,
    keyword: candidate.title,
    seasons: candidate.seasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      totalEpisodes: s.episodeCount,
      latestAiredEpisode: s.latestAiredEpisode,
    })),
  };
}
