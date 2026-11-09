import { createEpisodeStates, episodeNumberFromCode } from "../domain/domain.js";
import type { EpisodeState, TrackedSeason } from "../domain/domain.js";

export function hasIncompleteEpisodeStates(season: TrackedSeason, episodes: EpisodeState[]): boolean {
  if (season.totalEpisodes <= 0) return true;
  const codes = new Set(episodes.map((episode) => episode.episodeCode));
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  }).some((episode) => !codes.has(episode.episodeCode));
}

/**
 * Re-sync a tracked season against fresh TMDB metadata — the GUI equivalent of
 * the original skill's Type 3 `db.sync_all(tmdb)`. Without this, a season's
 * `latestAiredEpisode` is frozen at tracking time and the sweep can never
 * discover episodes that aired AFTER tracking began.
 *
 * Rules:
 * - `totalEpisodes` only ever advances (max). `latestAiredEpisode` follows fresh
 *   TMDB metadata in both directions so a bad read (including the old future-date
 *   bug) can heal; the floor keeps obtained episodes aired and is capped by the
 *   stored count, so it never raises the count and provider-ahead episodes remain
 *   reported as ahead.
 * - Newly-aired episodes surface as aired-but-not-obtained (real gaps the
 *   sweep will then acquire); a higher total grows the episode list.
 * - Already-obtained episodes keep their obtained flag and verified files.
 * - `status` is intentionally left untouched: episodes still need acquiring,
 *   so the season must stay in whatever lifecycle state it was — only the
 *   finale (all obtained) graduates it to completed.
 */
export function syncSeasonAgainstMetadata(input: {
  season: TrackedSeason;
  episodes: EpisodeState[];
  latestAiredEpisode: number;
  totalEpisodes: number;
}): { season: TrackedSeason; episodes: EpisodeState[]; changed: boolean } {
  const newTotal = Math.max(input.season.totalEpisodes, input.totalEpisodes);
  const highestObtained = Math.max(
    0,
    ...input.episodes
      .filter((episode) => episode.obtained)
      .map((episode) => episodeNumberFromCode(episode.episodeCode)),
  );
  const newLatest = Math.min(
    newTotal,
    Math.max(input.latestAiredEpisode, Math.min(input.season.latestAiredEpisode, highestObtained)),
  );
  const metadataChanged = newTotal !== input.season.totalEpisodes || newLatest !== input.season.latestAiredEpisode;
  const recordsMissing = newTotal > 0 && hasIncompleteEpisodeStates({ ...input.season, totalEpisodes: newTotal }, input.episodes);
  const changed = metadataChanged || recordsMissing;
  if (!changed) {
    return { season: input.season, episodes: input.episodes, changed: false };
  }

  const season: TrackedSeason = { ...input.season, totalEpisodes: newTotal, latestAiredEpisode: newLatest };
  const baseline = createEpisodeStates({
    trackedSeasonId: input.season.id,
    seasonNumber: input.season.seasonNumber,
    totalEpisodes: newTotal,
    latestAiredEpisode: newLatest,
  });
  const oldByCode = new Map(input.episodes.map((episode) => [episode.episodeCode, episode]));
  const merged: EpisodeState[] = baseline.map((base) => {
    const old = oldByCode.get(base.episodeCode);
    if (old === undefined) {
      return base;
    }
    if (!metadataChanged) return old;
    return { ...old, airStatus: base.airStatus };
  });

  // Preserve all recorded episodes beyond the metadata total.
  const mergedCodes = new Set(merged.map((episode) => episode.episodeCode));
  for (const old of input.episodes) {
    if (!mergedCodes.has(old.episodeCode)) {
      merged.push(old);
    }
  }

  return { season, episodes: merged, changed: true };
}
