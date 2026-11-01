export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

export type CandidateReserveRequestResult =
  | { status: "reserved" | "already_running" | "already_tracked"; trackedSeasonId: string }
  | { status: "unsupported"; message: string };

export type ImportState =
  | { kind: "idle" }
  | { kind: "submitting"; candidateId: string }
  | { kind: "queued" }
  | { kind: "already_running" }
  | { kind: "rejected"; message: string; reason?: string };

export interface ResourceLinkResponse {
  ok: boolean;
  candidateId: string;
  type: string;
  source: string;
  url: string;
  password: string | null;
  formatted: string;
  isMagnet: boolean;
  isHttp: boolean;
}
