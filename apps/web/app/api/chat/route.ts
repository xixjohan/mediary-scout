import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../lib/auth-chain";
import { handleChatTurn } from "../../../lib/chat-agent-service";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ChatRequestBody {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  storageId?: string | undefined;
}

function parseChatBody(val: unknown): ChatRequestBody | null {
  if (typeof val !== "object" || val === null) return null;
  const raw = val as Record<string, unknown>;
  if (!Array.isArray(raw["messages"])) return null;

  const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  for (const m of raw["messages"]) {
    if (typeof m === "object" && m !== null) {
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if (
        (role === "user" || role === "assistant" || role === "system") &&
        typeof content === "string"
      ) {
        messages.push({ role, content });
      }
    }
  }

  const storageId = typeof raw["storageId"] === "string" ? raw["storageId"].trim() : undefined;
  return { messages, storageId: storageId || undefined };
}

export async function POST(request: NextRequest) {
  await connection();

  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const rawJson: unknown = await request.json().catch(() => null);
  const parsed = parseChatBody(rawJson);
  if (!parsed) {
    return NextResponse.json({ error: "invalid chat payload" }, { status: 400, headers: NO_STORE });
  }

  const result = await handleChatTurn({
    messages: parsed.messages,
    accountId,
    storageId: parsed.storageId,
  });

  return NextResponse.json(result, { headers: NO_STORE });
}
