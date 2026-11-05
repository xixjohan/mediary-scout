import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  InMemoryWorkflowRepository,
  type WorkflowRepository,
} from "@media-track/workflow";

// Mock runtime container
let currentMockUser = "acct_alice";
let mockRepo: WorkflowRepository;

vi.mock("../../../composition/runtime-container", () => ({
  requireAuthenticatedAccountId: vi.fn(async () => currentMockUser),
  getCurrentAccountId: vi.fn(async () => currentMockUser),
  getWorkflowRepository: vi.fn(() => mockRepo),
}));

// Mock storage drives
vi.mock("../../storage-drives", () => ({
  resolveQueueStorage: vi.fn(async () => ({
    id: "cs_shared_pool",
    provider: "pan115",
    unknown: false,
    frozen: false,
  })),
  frozenDriveMessage: vi.fn(() => "frozen"),
  getAccountDriveFileManager: vi.fn(async () => null),
}));

import { queueCandidateTracking } from "./acquisition-service";

describe("Shared Resource Acquisition Pipeline", () => {
  const originalMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
  const originalMode = process.env.MEDIA_TRACK_MULTI_USER_MODE;

  beforeEach(() => {
    mockRepo = new InMemoryWorkflowRepository();
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    process.env.MEDIA_TRACK_MULTI_USER_MODE = "shared";
    currentMockUser = "acct_alice";
  });

  afterEach(() => {
    if (originalMultiUser !== undefined) {
      process.env.MEDIA_TRACK_MULTI_USER = originalMultiUser;
    } else {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
    if (originalMode !== undefined) {
      process.env.MEDIA_TRACK_MULTI_USER_MODE = originalMode;
    } else {
      delete process.env.MEDIA_TRACK_MULTI_USER_MODE;
    }
    vi.restoreAllMocks();
  });

  it("deduplicates requests in shared mode: User B joins User A's active acquisition", async () => {
    // Use the demo candidate for TV Season 1: 翘楚
    const candidateId = "tmdb_tv_289271_s1";

    // 1. User A initiates acquisition
    currentMockUser = "acct_alice";
    const resA = await queueCandidateTracking(candidateId);
    if (resA.status !== "queued") throw new Error("not queued");
    expect(resA.status).toBe("queued");
    expect(resA.workflowRunId).toBeDefined();

    // Verify Alice's request was recorded
    const aliceRequests = await mockRepo.listMediaRequests({ accountId: "acct_alice" });
    expect(aliceRequests).toHaveLength(1);
    expect(aliceRequests[0]?.mediaTitleId).toBe("tmdb_tv_289271");
    expect(aliceRequests[0]?.seasonNumber).toBe(1);
    expect(aliceRequests[0]?.workflowRunId).toBe(resA.workflowRunId);

    // 2. User B requests the exact same TV season while User A's run is active
    currentMockUser = "acct_bob";
    const resB = await queueCandidateTracking(candidateId);
    if (resB.status !== "queued") throw new Error("not queued");
    expect(resB.status).toBe("queued");
    // Should attach to User A's existing run
    expect(resB.workflowRunId).toBe(resA.workflowRunId);

    // Verify Bob's request was recorded and points to the same workflowRunId
    const bobRequests = await mockRepo.listMediaRequests({ accountId: "acct_bob" });
    expect(bobRequests).toHaveLength(1);
    expect(bobRequests[0]?.mediaTitleId).toBe("tmdb_tv_289271");
    expect(bobRequests[0]?.seasonNumber).toBe(1);
    expect(bobRequests[0]?.workflowRunId).toBe(resA.workflowRunId);

    // 3. Complete the run under the shared pool
    const completedCount = await mockRepo.completeMediaRequestsForRun(resA.workflowRunId!, "ready");
    expect(completedCount).toBe(2);

    const updatedA = await mockRepo.getMediaRequest(aliceRequests[0]!.id);
    const updatedB = await mockRepo.getMediaRequest(bobRequests[0]!.id);
    expect(updatedA?.status).toBe("ready");
    expect(updatedB?.status).toBe("ready");
  });
});
