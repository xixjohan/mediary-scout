import { connection, NextResponse, type NextRequest } from "next/server";
import {
  defaultShareInspectorRegistry,
  resourceSearchRunId,
  type ResourceInspectionResult,
  type ResourceSnapshot,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function parseInspectRequestBody(
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

export async function POST(request: NextRequest) {
  await connection();

  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  let parsed: ReturnType<typeof parseInspectRequestBody>;
  try {
    parsed = parseInspectRequestBody(await request.json());
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

  const inspection: ResourceInspectionResult = await defaultShareInspectorRegistry.inspect(candidate);
  return NextResponse.json(inspection, { headers: NO_STORE });
}
