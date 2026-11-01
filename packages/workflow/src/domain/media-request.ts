/**
 * Media requests (点播请求) for Shared Resource Mode.
 *
 * In shared mode, multiple users can request movies or TV seasons against a
 * single shared storage pool. Media requests decouple a user's intent ("I want
 * to watch this") from the underlying single-instance acquisition workflow.
 */

export type MediaRequestStatus =
  | "pending_approval"
  | "queued"
  | "acquiring"
  | "ready"
  | "rejected"
  | "failed";

export interface MediaRequest {
  id: string;
  accountId: string;
  mediaTitleId: string;
  seasonNumber: number | null;
  status: MediaRequestStatus;
  rejectionReason: string | null;
  workflowRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMediaRequestInput {
  id?: string;
  accountId: string;
  mediaTitleId: string;
  seasonNumber?: number | null;
  status?: MediaRequestStatus;
  rejectionReason?: string | null;
  workflowRunId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MediaRequestStore {
  createMediaRequest(input: CreateMediaRequestInput): Promise<MediaRequest>;
  getMediaRequest(id: string): Promise<MediaRequest | null>;
  listMediaRequests(filter?: {
    accountId?: string;
    mediaTitleId?: string;
    status?: MediaRequestStatus;
  }): Promise<MediaRequest[]>;
  findActiveMediaRequest(
    mediaTitleId: string,
    seasonNumber?: number | null,
  ): Promise<MediaRequest | null>;
  updateMediaRequestStatus(
    id: string,
    status: MediaRequestStatus,
    input?: { rejectionReason?: string | null; workflowRunId?: string | null; now?: string },
  ): Promise<MediaRequest | null>;
  attachWorkflowRunToRequests(
    mediaTitleId: string,
    seasonNumber: number | null,
    workflowRunId: string,
  ): Promise<number>;
  completeMediaRequestsForRun(
    workflowRunId: string,
    status: "ready" | "failed",
    rejectionReason?: string | null,
  ): Promise<number>;
}
