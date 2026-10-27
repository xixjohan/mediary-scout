import type { MediaType, ResourceCandidate } from "./domain.js";

/**
 * The manual-import job carrier (batch 3, item ③).
 *
 * A manual import crosses a process boundary: the HTTP route builds the payload and
 * enqueues it into `sys_queue_jobs.payload_json`; a worker claims it later and reads
 * the JSON back. So this module has two halves, and the second is the one that keeps
 * the path honest:
 *
 *   buildManualImportJobPayload  — route side: assemble from a resolved candidate
 *   parseManualImportJobPayload  — worker side: validate what came back out of JSON
 *
 * Without the parse half, a malformed/legacy/hand-edited payload reaches the worker
 * as `any` and either crashes it (a dead-letter with an unreadable reason) or — worse
 * — imports from a payload missing the fields that scope the transfer to the right
 * drive. Validating on read turns both into a typed refusal.
 *
 * The payload deliberately carries the RAW providerPayload (share url + password).
 * That is the whole point of doing this server-side: the user's browser never held it.
 */
export interface ManualImportJobPayload {
  /** Discriminator for the worker's dispatch. */
  kind: "manual_import";
  /** The candidate the user picked, and the snapshot it came from (audit trail). */
  candidateId: string;
  snapshotId: string;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  /** Raw share url / magnet / password. Server-side only — never serialized to a
   *  client response. */
  providerPayload: Record<string, unknown>;
  /** Target drive scope: follows the current workspace (no drive picker, per plan).
   *  null = the account's primary/legacy single drive. */
  accountId: string;
  connectedStorageId: string | null;
}

export type ParsedManualImportJob =
  | { kind: "ok"; payload: ManualImportJobPayload }
  | { kind: "invalid"; reason: string };

const MEDIA_TYPES = new Set<string>(["tv", "movie"]);

export function buildManualImportJobPayload(input: {
  candidate: ResourceCandidate;
  snapshotId: string;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  accountId: string;
  connectedStorageId?: string | null;
}): ManualImportJobPayload {
  const { candidate } = input;
  return {
    kind: "manual_import",
    candidateId: candidate.id,
    // The candidate's own snapshotId is what was validated at resolve time; the
    // caller passes the same one. If they disagree the payload is lying about its
    // provenance and the worker would import from the wrong search.
    snapshotId: input.snapshotId,
    tmdbId: input.tmdbId,
    mediaType: input.mediaType,
    title: input.title,
    providerPayload: candidate.providerPayload,
    accountId: input.accountId,
    connectedStorageId: input.connectedStorageId ?? null,
  };
}

/** True when the resolved candidate's provenance matches the snapshot it came from. */
export function candidateBelongsToSnapshot(candidate: ResourceCandidate, snapshotId: string): boolean {
  return candidate.snapshotId === snapshotId;
}

/** `key` must be a non-empty string; returns the reason it is not, or null. */
function requireNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) return `${key} must be a non-empty string`;
  return null;
}

/**
 * Field-level validation, split out from `parseManualImportJobPayload` so the parser
 * stays a thin dispatcher (and under the repo's complexity budget). Returns the first
 * reason a field is unusable, or null when all of them are.
 */
function validateManualImportFields(record: Record<string, unknown>): string | null {
  for (const key of ["candidateId", "snapshotId", "title", "accountId"] as const) {
    const reason = requireNonEmptyString(record, key);
    if (reason !== null) return reason;
  }
  const tmdbId = record.tmdbId;
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return "tmdbId must be a positive integer";
  }
  const mediaType = record.mediaType;
  if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) {
    return "mediaType must be tv or movie";
  }
  const providerPayload = record.providerPayload;
  if (typeof providerPayload !== "object" || providerPayload === null || Array.isArray(providerPayload)) {
    return "providerPayload must be an object";
  }
  const connectedStorageId = record.connectedStorageId;
  if (connectedStorageId !== null && typeof connectedStorageId !== "string") {
    return "connectedStorageId must be a string or null";
  }
  return null;
}

/**
 * Validate a payload read back out of `sys_queue_jobs.payload_json`.
 *
 * Every field is checked for presence AND type, because JSON round-trips lose
 * `undefined` and a missing field would otherwise surface as a runtime crash deep in
 * the transfer. `connectedStorageId` is the one nullable field (legacy/single-drive).
 */
export function parseManualImportJobPayload(value: unknown): ParsedManualImportJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", reason: "payload is not an object" };
  }
  const record = value as Record<string, unknown>;

  if (record.kind !== "manual_import") {
    return { kind: "invalid", reason: `unexpected kind: ${String(record.kind)}` };
  }
  const reason = validateManualImportFields(record);
  if (reason !== null) return { kind: "invalid", reason };

  const providerPayload = record.providerPayload as Record<string, unknown>;
  return {
    kind: "ok",
    payload: {
      kind: "manual_import",
      candidateId: record.candidateId as string,
      snapshotId: record.snapshotId as string,
      tmdbId: record.tmdbId as number,
      mediaType: record.mediaType as MediaType,
      title: record.title as string,
      providerPayload,
      accountId: record.accountId as string,
      connectedStorageId: (record.connectedStorageId as string | null) ?? null,
    },
  };
}

/**
 * Round-trip the way the queue does: JSON in, validated payload out. A payload that
 * survives its own serialization is the only kind worth enqueueing.
 */
export function roundTripManualImportJob(
  payload: ManualImportJobPayload,
): ParsedManualImportJob {
  return parseManualImportJobPayload(JSON.parse(JSON.stringify(payload)) as unknown);
}
