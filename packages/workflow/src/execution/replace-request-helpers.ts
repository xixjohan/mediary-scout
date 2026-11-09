import type { AuditEvent, EpisodeState, TrackedSeason } from "../domain/domain.js";
import type { TrackedSeasonState, WorkflowRepository } from "../persistence/repository.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";
import type { UserMessage, UserMessageScope } from "./user-requests.js";
export type ReplaceRequestOrigin = "patrol" | "user";

export type SeasonMetadataSync = (input: { tmdbId: number; seasonNumber: number; accountId: string }) => Promise<{
  latestAiredEpisode: number;
  totalEpisodes: number;
} | null>;

/** 待换 records and episode sources after a replace run. */
export async function recordReplacementOutcome(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  runId: string;
  results: Array<{
    episode: string;
    outcome: "replaced" | "not_found";
    label?: string;
    linkKey?: string | null;
    sizeBytes: number | null;
  }>;
  messages: UserMessage[];
  /** The work's 待换 rows when the run claimed its work. */
  pendingRows: Array<{ episode: string; messageId: string }>;
  /** Episodes whose copy the agent rejected this run (a rejection this run added to the list). */
  rejectedEpisodes: string[];
  /** A film: each of its messages means the film, tagged or not. */
  film: boolean;
  now: () => string;
}): Promise<void> {
  const { repository, work, messages, pendingRows, now } = input;
  const replaced = input.results.filter((r) => r.outcome === "replaced");
  const pendingAtStart = new Set(pendingRows.map((p) => p.episode));
  const askedByMessages = input.film
    ? messages.length > 0
      ? ["MOVIE"]
      : []
    : messages.flatMap((m) => m.episodeTags);
  const askedAgain = new Set([...askedByMessages, ...input.rejectedEpisodes]);
  const notFound = input.results
    .filter((r) => r.outcome === "not_found")
    .map((r) => r.episode)
    .filter((episode) => !pendingAtStart.has(episode) || askedAgain.has(episode));

  for (const r of replaced) {
    await repository.upsertEpisodeSource({
      ...work,
      episode: r.episode,
      linkKey: r.linkKey ?? null,
      label: r.label ?? "",
      sizeBytes: r.sizeBytes,
      runId: input.runId,
      recordedAt: now(),
    });
    await repository.removePendingReplacements({ ...work, episodes: [r.episode] });
  }

  const byMessage = new Map<string, string[]>();
  for (const episode of notFound) {
    const messageId =
      pendingRows.find((p) => p.episode === episode)?.messageId ??
      messageFor(messages, episode)?.id ??
      pendingRows[0]?.messageId;
    if (messageId === undefined) continue;
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), episode]);
  }
  for (const [messageId, episodes] of byMessage) {
    await repository.addPendingReplacements({ ...work, episodes, messageId, now: now() });
  }
}

/** Whether an episode code belongs to this work on this drive: "MOVIE" for a film,
 *  SxxEyy of a tracked season for a show. */
export function episodeScope(
  movie: boolean,
  states: TrackedSeasonState[],
): (episode: string) => boolean {
  if (movie) return (episode) => episode === "MOVIE";
  const seasons = new Set(states.map((s) => s.season.seasonNumber));
  return (episode) => {
    const m = /^S(\d{2,})E\d{2,}$/.exec(episode);
    return m !== null && seasons.has(Number(m[1]));
  };
}

/** Every season refreshed against TMDB (best-effort per season, as in the patrol). */
export async function syncedSeasons(
  states: TrackedSeasonState[],
  tmdbId: number,
  sync: SeasonMetadataSync | undefined,
): Promise<Array<{ season: TrackedSeason; episodes: EpisodeState[] }>> {
  const out: Array<{ season: TrackedSeason; episodes: EpisodeState[] }> = [];
  for (const state of states) {
    let entry = { season: state.season, episodes: state.episodes };
    if (sync) {
      try {
        const meta = await sync({ tmdbId, seasonNumber: state.season.seasonNumber, accountId: state.accountId });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({
            ...entry,
            latestAiredEpisode: meta.latestAiredEpisode,
            totalEpisodes: meta.totalEpisodes,
          });
          entry = { season: synced.season, episodes: synced.episodes };
        }
      } catch {
        // Metadata sync is best-effort; fall back to stored counts.
      }
    }
    out.push(entry);
  }
  return out;
}

/** Who queued the run (the queued audit event's origin); "user" when unknown. */
export function queuedBy(events: AuditEvent[]): ReplaceRequestOrigin {
  const origin = events.find((e) => e.type === "replace_request_queued")?.data?.["origin"];
  return origin === "patrol" ? "patrol" : "user";
}

/** The message that named this episode, else the oldest one claimed. */
export function messageFor(messages: UserMessage[], episode: string): UserMessage | undefined {
  return messages.find((m) => m.episodeTags.includes(episode)) ?? messages[0];
}

/** The per-account options the runners take, present only when resolved. */
export function optionalDeps(deps: any): any {
  return {
    ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
    ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
    ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
    ...(deps.assrtToken === undefined ? {} : { assrtToken: deps.assrtToken }),
    ...(deps.jevJudge === undefined ? {} : { jevJudge: deps.jevJudge }),
    ...(deps.agentMemory === undefined ? {} : { agentMemory: deps.agentMemory }),
    ...(deps.titleResearch === undefined ? {} : { titleResearch: deps.titleResearch }),
  };
}
