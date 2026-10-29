import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const repo = getWorkflowRepository();
  const conversations = await repo.listConversations({ accountId });
  return NextResponse.json(conversations, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const raw: unknown = await request.json().catch(() => ({}));
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const title =
    typeof body["title"] === "string" && body["title"].trim()
      ? body["title"].trim()
      : "新对话";
  const storageId = typeof body["storageId"] === "string" ? body["storageId"].trim() : undefined;

  const repo = getWorkflowRepository();
  const conv = await repo.createConversation({
    accountId,
    title,
    storageId: storageId || null,
    now: new Date().toISOString(),
  });

  return NextResponse.json(conv, { status: 201, headers: NO_STORE });
}
