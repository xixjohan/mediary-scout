import type { ResourceCandidate, ResourceType } from "../domain/domain.js";
import { defaultResourceMetaExtractor } from "../domain/resource-meta-enricher.js";

/**
 * Candidate view model for the human-facing resource panel (W2).
 *
 * `ResourceCandidate.providerPayload` is the raw, provider-specific acquisition
 * payload: a PanSou share `url` + `password`, a Prowlarr `magnet`/`downloadUrl`/
 * `infoHash`. Those strings ARE the capability — a share link's extract code and a
 * magnet's info hash are how you get the content. They must never reach a browser:
 * the plan is explicit ("payload 绝不下前端") and the batch-2 acceptance criterion
 * is "响应体断言不含 URL 形态".
 *
 * What the panel actually needs, per the plan: 「终于能看到某部片有哪些资源、多大、
 * 什么时候发的」. So this projects exactly those fields and nothing else.
 *
 * The safety property is STRUCTURAL, not a filter: the view is built field by field
 * and the payload is never spread, so an unknown or newly-added payload key cannot
 * leak by default. A test that stuffs URL-shaped strings under many key names and
 * deep-scans the result guards that property (see tests).
 */
export interface ResourceCandidateView {
  /** Stable id the later cache-TTL and manual-import paths key on. */
  candidateId: string;
  title: string;
  type: ResourceType;
  /** Indexer / source label ("pansou-115", an indexer name, …). */
  source: string;
  /** Bytes, when the provider reports it or parsed deterministically from title. */
  sizeBytes?: number;
  /** ISO-8601 publish time, when the provider reports it or parsed from title. */
  postedAt?: string;
  /** Swarm health, Prowlarr only. */
  seeders?: number;
  /** File or episode count, when reported or parsed deterministically from title. */
  fileCount?: number;
}

/** Read a finite number, else undefined. Never coerces a string that looks numeric. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Project one candidate. Unknown payload keys are dropped by construction. */
export function toCandidateView(candidate: ResourceCandidate): ResourceCandidateView {
  const payload = candidate.providerPayload ?? {};
  const view: ResourceCandidateView = {
    candidateId: candidate.id,
    title: candidate.title,
    type: candidate.type,
    source: candidate.source,
  };
  // Only safe scalar facts cross the boundary. Unknown keys in payload are discarded.
  const enriched = defaultResourceMetaExtractor.resolve(candidate.title, payload);
  if (enriched.sizeBytes !== undefined) view.sizeBytes = enriched.sizeBytes;
  if (enriched.postedAt !== undefined) view.postedAt = enriched.postedAt;
  if (enriched.fileCount !== undefined) view.fileCount = enriched.fileCount;

  const seeders = finiteNumber(payload.seeders);
  if (seeders !== undefined) view.seeders = seeders;

  return view;
}

export function toCandidateViews(candidates: readonly ResourceCandidate[]): ResourceCandidateView[] {
  return candidates.map(toCandidateView);
}
