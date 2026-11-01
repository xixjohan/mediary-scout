import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../lib/auth-chain";
import { getWorkflowRepository, getCurrentAccountSummary } from "../../../lib/workflow-runtime";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const url = new URL(request.url);
  const titleId = url.searchParams.get("titleId") || undefined;
  const statusParam = url.searchParams.get("status") as import("@media-track/workflow").MediaRequestStatus | null;
  const allParam = url.searchParams.get("all") === "1";

  const summary = await getCurrentAccountSummary();
  const isOwner = summary?.isOwner ?? false;

  const repo = getWorkflowRepository();
  const filter: {
    accountId?: string;
    mediaTitleId?: string;
    status?: import("@media-track/workflow").MediaRequestStatus;
  } = {};

  if (!isOwner || !allParam) {
    filter.accountId = accountId;
  }
  if (titleId) {
    filter.mediaTitleId = titleId;
  }
  if (statusParam) {
    filter.status = statusParam;
  }

  const requests = await repo.listMediaRequests(filter);
  return NextResponse.json(requests, { headers: NO_STORE });
}

export async function PATCH(request: NextRequest) {
  await connection();
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    status?: unknown;
    rejectionReason?: unknown;
  } | null;

  if (!body || typeof body.id !== "string" || typeof body.status !== "string") {
    return NextResponse.json({ error: "必须提供请求 ID 与目标状态" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const existing = await repo.getMediaRequest(body.id);
  if (!existing) {
    return NextResponse.json({ error: "未找到该点播请求" }, { status: 404 });
  }

  const summary = await getCurrentAccountSummary();
  const isOwner = summary?.isOwner ?? false;

  // 普通成员仅能取消自己待审批/排队中的请求
  if (!isOwner && existing.accountId !== accountId) {
    return NextResponse.json({ error: "无权操作其他成员的点播请求" }, { status: 403 });
  }

  const updated = await repo.updateMediaRequestStatus(
    body.id,
    body.status as import("@media-track/workflow").MediaRequestStatus,
    {
      rejectionReason: typeof body.rejectionReason === "string" ? body.rejectionReason : null,
    },
  );

  return NextResponse.json(updated, { headers: NO_STORE });
}
