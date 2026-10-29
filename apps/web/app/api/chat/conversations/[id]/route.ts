import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { id } = await props.params;
  const repo = getWorkflowRepository();
  const conversation = await repo.getConversation({ accountId, id });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404, headers: NO_STORE });
  }

  const messages = await repo.listMessages({ accountId, conversationId: id });
  return NextResponse.json({ conversation, messages }, { headers: NO_STORE });
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { id } = await props.params;
  const raw: unknown = await request.json().catch(() => null);
  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400, headers: NO_STORE });
  }

  const rawObj = raw as Record<string, unknown>;
  const title = typeof rawObj["title"] === "string" ? rawObj["title"].trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400, headers: NO_STORE });
  }

  const repo = getWorkflowRepository();
  const updated = await repo.updateConversation({
    accountId,
    id,
    title,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(updated, { headers: NO_STORE });
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { id } = await props.params;
  const repo = getWorkflowRepository();
  const deleted = await repo.deleteConversation({ accountId, id });

  return NextResponse.json({ success: deleted }, { headers: NO_STORE });
}
