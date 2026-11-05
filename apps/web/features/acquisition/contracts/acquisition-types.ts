import type { ResourceCandidateView, MergedSourceHealth, ResourceFileNode, ResourceValidityStatus } from "@media-track/workflow";

export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
      message?: string | undefined;
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

export interface CandidateInspectionState {
  status: ResourceValidityStatus;
  loading: boolean;
  message?: string | undefined;
  totalSizeBytes?: number | undefined;
  fileCount?: number | undefined;
  files?: ResourceFileNode[] | undefined;
}

export type PanelState =
  | { kind: "idle" }
  | {
      kind: "loading";
      previousCandidates?: ResourceCandidateView[] | undefined;
      previousSnapshotId?: string | null | undefined;
      sourceHealth?: MergedSourceHealth | undefined;
    }
  | {
      kind: "streaming";
      candidates: ResourceCandidateView[];
      progress: { done: number; total: number; currentKeyword?: string };
      sourceHealth?: MergedSourceHealth | undefined;
    }
  | {
      kind: "ready";
      candidates: ResourceCandidateView[];
      cached: boolean;
      snapshotId: string | null;
      sourceHealth?: MergedSourceHealth | undefined;
    }
  | {
      kind: "throttled";
      retryAfterMs: number;
      previousCandidates?: ResourceCandidateView[] | undefined;
      previousSnapshotId?: string | null | undefined;
      sourceHealth?: MergedSourceHealth | undefined;
    }
  | { kind: "error"; message: string };
