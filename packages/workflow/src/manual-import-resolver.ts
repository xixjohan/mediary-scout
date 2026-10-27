import type { ResourceCandidate, ResourceSnapshot } from "./domain.js";

/**
 * Manual-import candidate resolution (batch 3, the first drive-WRITE path).
 *
 * The user picks a candidateId on the detail page and presses 手动入库. That id was
 * minted by `POST /api/titles/resources`, which answered from a TTL cache — and the
 * cache's `TitleResourceCache` is process memory. The obvious shortcut is to hand
 * the id back to `CandidateRegistry`, the in-process Map the agent path uses. That
 * would be wrong twice over:
 *
 *   1. It dies with the process. A user who queries resources and comes back after
 *      a restart would import from an empty registry — the request would fail for a
 *      reason the UI cannot explain.
 *   2. It is keyed by candidateId alone, so it cannot answer "does this candidate
 *      belong to THIS snapshot?" — which is exactly the check the plan requires
 *      (「import 时必须校验 candidateId 确实属于传入的 snapshotId」).
 *
 * So the payload is recovered from the PERSISTED snapshot, and the candidateId is
 * validated against that snapshot's own id. This module is that check plus the TTL
 * re-check; it is deliberately pure (no DB, no clock) so both halves are testable.
 */

/** How long a candidateId stays importable — mirrors the query endpoint's TTL. */
export const MANUAL_IMPORT_TTL_MS = 30 * 60 * 1000;

export type ManualImportCandidateResult =
  /** Resolved: the candidate, with its providerPayload, ready to enqueue. */
  | { kind: "ok"; candidate: ResourceCandidate }
  /** The id is not a member of this snapshot — a stale/foreign/hand-edited id. */
  | { kind: "not_found" }
  /** The snapshot is older than the TTL. The id may be real, but it has expired. */
  | { kind: "expired"; ageMs: number }
  /** The snapshot itself is unusable (no id, or an unparseable createdAt). */
  | { kind: "invalid_snapshot"; reason: string };

/**
 * Resolve a user-held candidateId against a persisted snapshot.
 *
 * Order matters: membership FIRST, then TTL. An id that isn't in this snapshot gets
 * `not_found` even if the snapshot is also expired — the caller's actionable error is
 * "that candidate isn't from this search", and a TTL message would send them looking
 * at the wrong thing.
 */
export function resolveManualImportCandidate(input: {
  snapshot: ResourceSnapshot;
  candidateId: string;
  /** Injectable clock (ms since epoch). */
  now: number;
  ttlMs?: number;
}): ManualImportCandidateResult {
  const { snapshot, candidateId, now } = input;
  const ttlMs = input.ttlMs ?? MANUAL_IMPORT_TTL_MS;

  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
    return { kind: "invalid_snapshot", reason: "snapshot has no id" };
  }
  if (!Array.isArray(snapshot.candidates)) {
    return { kind: "invalid_snapshot", reason: "snapshot has no candidate list" };
  }

  // Membership: the candidate must name THIS snapshot. Checking only
  // `candidate.id === candidateId` would accept an id lifted from any other search.
  const candidate = snapshot.candidates.find(
    (entry) => entry.id === candidateId && entry.snapshotId === snapshot.id,
  );
  if (candidate === undefined) {
    return { kind: "not_found" };
  }

  const createdAtMs = Date.parse(snapshot.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return { kind: "invalid_snapshot", reason: "snapshot createdAt is not a timestamp" };
  }
  const ageMs = now - createdAtMs;
  if (ageMs > ttlMs) {
    return { kind: "expired", ageMs };
  }

  return { kind: "ok", candidate };
}

/**
 * The importable window's remaining time, for the UI's 「剩余 N 秒」 hint.
 * Negative when expired. Returns null for an unusable snapshot rather than a
 * number that would render as a countdown to nothing.
 */
export function manualImportRemainingMs(
  snapshot: ResourceSnapshot,
  now: number,
  ttlMs: number = MANUAL_IMPORT_TTL_MS,
): number | null {
  const createdAtMs = Date.parse(snapshot.createdAt);
  if (Number.isNaN(createdAtMs)) return null;
  return ttlMs - (now - createdAtMs);
}
