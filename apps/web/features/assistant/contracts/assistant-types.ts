export type ProcessMessagesNowStatus = "queued" | "already_running" | "nothing_waiting";

export type MemoryAddressInput =
  | { scope: "global" }
  | { scope: "title"; mediaType: "movie" | "tv"; tmdbId: number };

export interface PendingEpisodeInput {
  episode: string;
  messageId: string;
  requestedAt: string;
}
