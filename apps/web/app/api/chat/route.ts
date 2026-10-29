import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../lib/auth-chain";
import { handleChatTurn } from "../../../lib/chat-agent-service";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";
import { heuristicConversationTitle } from "@media-track/workflow";

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ChatRequestBody {
  conversationId?: string | undefined;
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
  const conversationId =
    typeof raw["conversationId"] === "string" && raw["conversationId"].trim()
      ? raw["conversationId"].trim()
      : undefined;

  return { conversationId, messages, storageId: storageId || undefined };
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

  const repo = getWorkflowRepository();
  const lastUserMsg = [...parsed.messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg?.content.trim() ?? "";
  const now = new Date().toISOString();

  let conversationId = parsed.conversationId;
  if (!conversationId) {
    const title = heuristicConversationTitle(userText);
    const newConv = await repo.createConversation({
      accountId,
      title,
      storageId: parsed.storageId || null,
      now,
    });
    conversationId = newConv.id;
  } else {
    const existing = await repo.getConversation({ accountId, id: conversationId });
    if (!existing) {
      const title = heuristicConversationTitle(userText);
      const newConv = await repo.createConversation({
        id: conversationId,
        accountId,
        title,
        storageId: parsed.storageId || null,
        now,
      });
      conversationId = newConv.id;
    } else if (existing.title === "新对话" && userText) {
      await repo.updateConversation({
        accountId,
        id: conversationId,
        title: heuristicConversationTitle(userText),
        updatedAt: now,
      });
    }
  }

  // 1. 持久化当前用户输入消息
  if (userText) {
    await repo.saveMessage({
      id: `msg_u_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 6)}`,
      conversationId,
      accountId,
      role: "user",
      content: userText,
      createdAt: now,
    });
  }

  // 2. 执行模型/意图轮次
  const result = await handleChatTurn({
    messages: parsed.messages,
    accountId,
    storageId: parsed.storageId,
  });

  // 3. 持久化模型回复与行动卡片
  const replyTime = new Date().toISOString();
  await repo.saveMessage({
    id: `msg_a_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 6)}`,
    conversationId,
    accountId,
    role: "assistant",
    content: result.reply,
    thinking: result.thinking || null,
    toolsUsed: result.toolsUsed || null,
    actionCard: result.actionCard || null,
    createdAt: replyTime,
  });

  return NextResponse.json(
    {
      ...result,
      conversationId,
    },
    { headers: NO_STORE },
  );
}
