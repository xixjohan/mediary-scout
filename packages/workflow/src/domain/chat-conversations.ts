/**
 * 智能对话助理会话与消息持久化领域模型（Chat Conversation & Message Domain）
 *
 * 规范：
 * - 纯 SQLite / 内存双实现；
 * - 严格遵循 multi-account 数据隔离；
 * - 提供启发式标题推导策略与时间分桶聚类工具函数。
 */

export interface ChatConversationSummary {
  id: string;
  accountId: string;
  title: string;
  storageId?: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedChatMessage {
  id: string;
  conversationId: string;
  accountId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string | null;
  toolsUsed?: unknown[] | null;
  actionCard?: unknown | null;
  createdAt: string;
}

export interface CreateConversationInput {
  id?: string;
  accountId: string;
  title: string;
  storageId?: string | null;
  now: string;
}

export interface SaveChatMessageInput {
  id: string;
  conversationId: string;
  accountId: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string | null;
  toolsUsed?: unknown[] | null;
  actionCard?: unknown | null;
  createdAt: string;
}

export interface ChatConversationRow {
  id: string;
  account_id: string;
  title: string;
  storage_id: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number | null;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  account_id: string;
  role: string;
  content: string;
  thinking: string | null;
  tools_used: string | null;
  action_card: string | null;
  created_at: string;
}

export function chatConversationSummaryFromRow(row: ChatConversationRow): ChatConversationSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    storageId: row.storage_id ?? null,
    messageCount: Number(row.message_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function persistedChatMessageFromRow(row: ChatMessageRow): PersistedChatMessage {
  let toolsUsed: unknown[] | null = null;
  if (row.tools_used) {
    try {
      toolsUsed = JSON.parse(row.tools_used);
    } catch {
      toolsUsed = null;
    }
  }
  let actionCard: unknown | null = null;
  if (row.action_card) {
    try {
      actionCard = JSON.parse(row.action_card);
    } catch {
      actionCard = null;
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    accountId: row.account_id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    thinking: row.thinking ?? null,
    toolsUsed,
    actionCard,
    createdAt: row.created_at,
  };
}

export interface ChatConversationStore {
  listConversations(input: { accountId: string }): Promise<ChatConversationSummary[]>;
  getConversation(input: { accountId: string; id: string }): Promise<ChatConversationSummary | null>;
  createConversation(input: CreateConversationInput): Promise<ChatConversationSummary>;
  updateConversation(input: {
    accountId: string;
    id: string;
    title?: string;
    updatedAt?: string;
  }): Promise<ChatConversationSummary | null>;
  deleteConversation(input: { accountId: string; id: string }): Promise<boolean>;
  listMessages(input: { accountId: string; conversationId: string }): Promise<PersistedChatMessage[]>;
  saveMessage(input: SaveChatMessageInput): Promise<PersistedChatMessage>;
}

/**
 * 启发式会话标题推导策略（Heuristic Title Generation Strategy）
 *
 * 剔除自然语言前缀（如“搜”、“帮我找”），截取核心意图词，若无有效文本回落默认占位。
 */
export function heuristicConversationTitle(prompt: string, maxLength = 20): string {
  if (!prompt || typeof prompt !== "string") {
    return "新对话";
  }

  // 1. 去除两端空白并替换换行为空格
  let cleaned = prompt.trim().replace(/[\r\n\t]+/g, " ");

  // 2. 正则清洗高频提问/指令前缀（支持多个连续前缀如 "请问有什么"）
  cleaned = cleaned.replace(
    /^(?:请问|帮我(?:找|搜|查|看|问一下)?|我想(?:看|找|知道)?|搜(?:索)?|查(?:找|看|询)?|推荐(?:一下)?|有哪些|有什么|\s+)+/gi,
    "",
  );

  // 3. 去除首尾常见的标点符号
  cleaned = cleaned.replace(/^[\s,，.。:：?？!！"“”'‘’\[\]()（）]+|[\s,，.。:：?？!！"“”'‘’\[\]()（）]+$/g, "");

  if (!cleaned) {
    return "新对话";
  }

  // 4. 按指定长度截断
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength).trim()}...`;
  }

  return cleaned;
}

export type ConversationDateBucket = "today" | "yesterday" | "past7Days" | "older";

export interface ConversationGroup {
  key: ConversationDateBucket;
  label: string;
  items: ChatConversationSummary[];
}

/**
 * 按时间流将对话记录聚类分桶（时间分桶策略）
 *
 * @param conversations 依 updatedAt DESC 排序的会话列表
 * @param referenceDate 参考当前时间，默认 new Date()
 */
export function groupConversationsByDate(
  conversations: ChatConversationSummary[],
  referenceDate = new Date(),
): ConversationGroup[] {
  const groups: Record<ConversationDateBucket, ChatConversationSummary[]> = {
    today: [],
    yesterday: [],
    past7Days: [],
    older: [],
  };

  const startOfToday = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfPast7Days = startOfToday - 7 * 24 * 60 * 60 * 1000;

  for (const conv of conversations) {
    const time = new Date(conv.updatedAt || conv.createdAt).getTime();
    if (isNaN(time)) {
      groups.older.push(conv);
      continue;
    }

    if (time >= startOfToday) {
      groups.today.push(conv);
    } else if (time >= startOfYesterday) {
      groups.yesterday.push(conv);
    } else if (time >= startOfPast7Days) {
      groups.past7Days.push(conv);
    } else {
      groups.older.push(conv);
    }
  }

  const result: ConversationGroup[] = [
    { key: "today", label: "今天", items: groups.today },
    { key: "yesterday", label: "昨天", items: groups.yesterday },
    { key: "past7Days", label: "过去 7 天", items: groups.past7Days },
    { key: "older", label: "更早", items: groups.older },
  ];

  return result.filter((g) => g.items.length > 0);
}
