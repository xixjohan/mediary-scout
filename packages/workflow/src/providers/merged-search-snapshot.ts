import type { ResourceCandidate, ResourceSnapshot } from "../domain/domain.js";

/**
 * Merge the per-keyword snapshots of one resource search into the ONE snapshot the
 * user actually saw (batch 3).
 *
 * Why this exists: the search runs a keyword ladder (bare title → title+year →
 * original → alias), so one user search produces SEVERAL snapshots. But the panel
 * shows the user a single deduped list, and `resolveManualImportCandidate` answers
 * "does this candidate belong to THIS snapshot?" for exactly one snapshot. Without a
 * merge, the same candidateId can appear in two snapshots with two different
 * `snapshotId` values, and the import check becomes ambiguous — a candidate found via
 * the original title would be rejected when the user picked it from the merged view.
 *
 * Two things this must get right, both learned the hard way:
 *   1. **Re-stamp snapshotId.** A candidate's `snapshotId` points at the snapshot it
 *      was found in; after merging it must point at the merged snapshot, or
 *      `candidateBelongsToSnapshot` rejects every candidate.
 *   2. **First occurrence wins.** Content-hashing providers (PanSou) give the same id
 *      to identical results, so the first keyword that found it is as good as any —
 *      and determinism matters for tests.
 */
export function buildMergedSearchSnapshot(input: {
  id: string;
  provider: string;
  keywords: readonly string[];
  snapshots: readonly ResourceSnapshot[];
  createdAt: string;
}): ResourceSnapshot {
  const byId = new Map<string, ResourceCandidate>();
  for (const snapshot of input.snapshots) {
    for (const candidate of snapshot.candidates) {
      if (byId.has(candidate.id)) continue; // first occurrence wins
      byId.set(candidate.id, {
        ...candidate,
        // (1) The candidate now lives in the merged snapshot, not the keyword's.
        snapshotId: input.id,
      });
    }
  }
  const candidates = [...byId.values()].map((candidate, index) => ({ ...candidate, index }));
  return {
    id: input.id,
    provider: input.provider,
    // The merged snapshot was produced by the whole ladder, not one keyword; saying
    // otherwise would misattribute where a candidate came from.
    keyword: input.keywords.join(" | "),
    candidates,
    createdAt: input.createdAt,
  };
}
