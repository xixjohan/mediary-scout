import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const mockRepo = new InMemoryWorkflowRepository();
let mockCurrentAccountId = "acct_alice";
let mockIsOwner = false;

vi.mock("../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn(async () => {
    if (mockCurrentAccountId === "unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return mockCurrentAccountId;
  }),
}));

vi.mock("../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: vi.fn(() => mockRepo),
  getCurrentAccountSummary: vi.fn(async () => ({
    id: mockCurrentAccountId,
    isOwner: mockIsOwner,
  })),
}));

import { GET } from "./route";

describe("GET /api/media-requests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCurrentAccountId = "acct_alice";
    mockIsOwner = false;

    // Reset repository data
    const aliceReqs = await mockRepo.listMediaRequests({ accountId: "acct_alice" });
    const bobReqs = await mockRepo.listMediaRequests({ accountId: "acct_bob" });
    // In-memory repo doesn't delete, so we can instantiate a fresh one or clear items
    (mockRepo as unknown as { mediaRequests: Map<string, unknown> }).mediaRequests?.clear();
  });

  it("returns 401 when unauthenticated", async () => {
    mockCurrentAccountId = "unauthorized";
    const req = new NextRequest("http://localhost:3000/api/media-requests");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns media requests for current user", async () => {
    await mockRepo.createMediaRequest({
      id: "req_alice_1",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_100",
      status: "queued",
    });
    await mockRepo.createMediaRequest({
      id: "req_bob_1",
      accountId: "acct_bob",
      mediaTitleId: "tmdb_movie_200",
      status: "ready",
    });

    const req = new NextRequest("http://localhost:3000/api/media-requests");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("req_alice_1");
  });

  it("filters by status and titleId", async () => {
    await mockRepo.createMediaRequest({
      id: "req_alice_1",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_100",
      status: "queued",
    });
    await mockRepo.createMediaRequest({
      id: "req_alice_2",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_100",
      status: "ready",
    });
    await mockRepo.createMediaRequest({
      id: "req_alice_3",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_300",
      status: "queued",
    });

    const req = new NextRequest("http://localhost:3000/api/media-requests?titleId=tmdb_movie_100&status=queued");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("req_alice_1");
  });

  it("allows owner to see all requests when all=1", async () => {
    mockCurrentAccountId = "acct_owner";
    mockIsOwner = true;

    await mockRepo.createMediaRequest({
      id: "req_alice_1",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_100",
      status: "queued",
    });
    await mockRepo.createMediaRequest({
      id: "req_bob_1",
      accountId: "acct_bob",
      mediaTitleId: "tmdb_movie_200",
      status: "ready",
    });

    const req = new NextRequest("http://localhost:3000/api/media-requests?all=1");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("prevents non-owner from seeing other users requests even if all=1 is requested", async () => {
    mockCurrentAccountId = "acct_alice";
    mockIsOwner = false;

    await mockRepo.createMediaRequest({
      id: "req_alice_1",
      accountId: "acct_alice",
      mediaTitleId: "tmdb_movie_100",
      status: "queued",
    });
    await mockRepo.createMediaRequest({
      id: "req_bob_1",
      accountId: "acct_bob",
      mediaTitleId: "tmdb_movie_200",
      status: "ready",
    });

    const req = new NextRequest("http://localhost:3000/api/media-requests?all=1");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("req_alice_1");
  });
});
