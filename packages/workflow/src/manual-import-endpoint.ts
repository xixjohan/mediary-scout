import type { ResourceSnapshot } from "./domain.js";
import {
  MANUAL_IMPORT_TTL_MS,
  resolveManualImportCandidate,
  type ManualImportCandidateResult,
} from "./manual-import-resolver.js";
import {
  buildManualImportJobPayload,
  roundTripManualImportJob,
  type ManualImportJobPayload,
} from "./manual-import-job.js";

/**
 * The import endpoint's decision core (batch 3, item ①).
 *
 * Pure: it takes the snapshot the caller looked up and returns either an
 * enqueue-ready payload or a typed refusal. Deliberately free of HTTP, DB and clock
 * so the whole decision is testable — and so the persistence question (WHERE the
 * snapshot came from) stays a separate concern from WHAT may be imported.
 *
 * The refusal reasons are user-facing copy, so each one names the actionable fact:
 *   · not_found     — that candidate isn't from this search
 *   · expired       — the 30-minute window closed; search again
 *   · invalid_*     — the stored snapshot is unusable (a bug or corruption, not the
 *                     user's fault — the copy must not blame them)
 */
export type ManualImportDecision =
  | { kind: "enqueue"; payload: ManualImportJobPayload }
  | { kind: "reject"; reason: ManualImportRejectionReason; detail?: string };

export type ManualImportRejectionReason =
  | "not_found"
  | "expired"
  | "invalid_snapshot"
  | "payload_invalid";

export interface ManualImportRequest {
  snapshot: ResourceSnapshot;
  candidateId: string;
  tmdbId: number;
  mediaType: "tv" | "movie";
  title: string;
  accountId: string;
  connectedStorageId?: string | null;
  /** Injectable clock (ms since epoch). */
  now: number;
  ttlMs?: number;
}

const COPY: Record<ManualImportRejectionReason, string> = {
  not_found: "这个候选不属于本次搜索，可能已过期或链接已失效。请重新查询资源。",
  expired: "资源查询已超过 30 分钟，候选已失效。请重新查询后再入库。",
  invalid_snapshot: "这次搜索的记录已损坏，无法入库。请重新查询资源。",
  payload_invalid: "入库任务装载失败，本次未做任何改动。请重新查询资源。",
};

export function manualImportRejectionCopy(reason: ManualImportRejectionReason): string {
  return COPY[reason];
}

/**
 * Decide whether a user-held candidateId may be imported, and build the job payload
 * if so.
 *
 * Every step that can refuse, refuses with a reason the UI can act on. The last step
 * (round-trip) is the one that is easy to skip and expensive to skip: the payload is
 * about to be serialized into `sys_queue_jobs.payload_json`, and a payload that
 * cannot survive its own JSON round-trip would fail later in the worker, after the
 * user has already been told it worked.
 */
export function decideManualImport(request: ManualImportRequest): ManualImportDecision {
  const resolved: ManualImportCandidateResult = resolveManualImportCandidate({
    snapshot: request.snapshot,
    candidateId: request.candidateId,
    now: request.now,
    // exactOptionalPropertyTypes: only pass ttlMs when the caller set one, so an
    // omitted ttl keeps the resolver's own default instead of overriding it with
    // undefined.
    ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
  });

  switch (resolved.kind) {
    case "not_found":
      return { kind: "reject", reason: "not_found" };
    case "expired":
      return { kind: "reject", reason: "expired" };
    case "invalid_snapshot":
      return { kind: "reject", reason: "invalid_snapshot", detail: resolved.reason };
    case "ok":
      break;
  }

  const payload = buildManualImportJobPayload({
    candidate: resolved.candidate,
    snapshotId: request.snapshot.id,
    tmdbId: request.tmdbId,
    mediaType: request.mediaType,
    title: request.title,
    accountId: request.accountId,
    connectedStorageId: request.connectedStorageId ?? null,
  });

  const roundTripped = roundTripManualImportJob(payload);
  if (roundTripped.kind !== "ok") {
    return { kind: "reject", reason: "payload_invalid", detail: roundTripped.reason };
  }

  return { kind: "enqueue", payload: roundTripped.payload };
}

export { MANUAL_IMPORT_TTL_MS };
