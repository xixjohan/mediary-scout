import { connection, NextResponse, type NextRequest } from "next/server";
import { resourceSearchRunId, type ResourceCandidate, type ResourceSnapshot } from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

export function parseLinkRequestBody(
  value: unknown
): { ok: true; tmdbId: number; snapshotId: string; candidateId: string } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const body = value as { tmdbId?: unknown; snapshotId?: unknown; candidateId?: unknown };
  const tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : Number.NaN;
  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId.trim() : "";
  const candidateId = typeof body.candidateId === "string" ? body.candidateId.trim() : "";

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId must be a positive integer" };
  }
  if (!snapshotId || !candidateId) {
    return { ok: false, error: "snapshotId and candidateId are required" };
  }
  return { ok: true, tmdbId, snapshotId, candidateId };
}

export function extractCandidateLinkInfo(candidate: ResourceCandidate): ResourceLinkResponse {
  const payload = candidate.providerPayload ?? {};
  const rawUrl = typeof payload["url"] === "string" ? payload["url"].trim() : "";
  const rawPassword =
    typeof payload["password"] === "string"
      ? payload["password"].trim()
      : typeof payload["passcode"] === "string"
      ? payload["passcode"].trim()
      : "";

  const isMagnet = rawUrl.startsWith("magnet:");
  const isHttp = rawUrl.startsWith("http://") || rawUrl.startsWith("https://");

  let formatted = rawUrl;
  if (rawPassword) {
    formatted = `${rawUrl} 提取码: ${rawPassword}`;
  } else if (!rawUrl) {
    formatted = "暂无直接可访问链接";
  }

  return {
    ok: true,
    candidateId: candidate.id,
    type: candidate.type,
    source: candidate.source,
    url: rawUrl,
    password: rawPassword || null,
    formatted,
    isMagnet,
    isHttp,
  };
}

export async function POST(request: NextRequest) {
  await connection();

  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  let parsed: ReturnType<typeof parseLinkRequestBody>;
  try {
    parsed = parseLinkRequestBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  const { tmdbId, snapshotId, candidateId } = parsed;

  const record = await getWorkflowRepository().getWorkflowRunSnapshot(
    resourceSearchRunId(snapshotId),
    accountId
  );
  if (record === null) {
    return NextResponse.json({ error: "snapshot not found" }, { status: 404, headers: NO_STORE });
  }

  const snapshot: ResourceSnapshot | undefined = record.resourceSnapshots.find(
    (entry) => entry.id === snapshotId
  );
  if (snapshot === undefined) {
    return NextResponse.json({ error: "snapshot not found" }, { status: 404, headers: NO_STORE });
  }

  if (record.title.tmdbId !== tmdbId) {
    return NextResponse.json(
      { error: "snapshot does not belong to this title" },
      { status: 400, headers: NO_STORE }
    );
  }

  const candidate = snapshot.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    return NextResponse.json({ error: "candidate not found in snapshot" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(extractCandidateLinkInfo(candidate), { headers: NO_STORE });
}
