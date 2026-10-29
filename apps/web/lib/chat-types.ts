/**
 * 智能对话助理类型定义（Chat Agent Types）
 */

export interface ActionCardMediaItem {
  tmdbId: number;
  title: string;
  year?: number | undefined;
  mediaType: "movie" | "tv";
  posterPath?: string | undefined;
  overview?: string | undefined;
  statusText?: string | undefined;
  releaseDate?: string | undefined;
}

export interface ActionCardCandidateItem {
  candidateId: string;
  title: string;
  type: string;
  sizeBytes?: number | undefined;
  seeders?: number | undefined;
}

export interface ActionCardActiveRunItem {
  id: string;
  title: string;
  phase: string;
  progress?: number | undefined;
}

export interface ActionCardLibraryItem {
  tmdbId: number;
  title: string;
  type: string;
  status: string;
}

export type ActionCardPayload =
  | {
      kind: "media_list";
      query: string;
      items: ActionCardMediaItem[];
    }
  | {
      kind: "resource_list";
      tmdbId: number;
      title: string;
      snapshotId: string | null;
      candidates: ActionCardCandidateItem[];
    }
  | {
      kind: "activity_status";
      activeRuns: ActionCardActiveRunItem[];
    }
  | {
      kind: "library_summary";
      trackedCount: number;
      items: ActionCardLibraryItem[];
    };

export interface ToolCallItem {
  id: string;
  toolName: string;
  args?: Record<string, unknown> | undefined;
  status: "running" | "success" | "error";
  summary: string;
}

export interface ChatTurnInput {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  accountId: string;
  storageId?: string | undefined;
}

export interface ChatTurnResult {
  reply: string;
  thinking?: string | undefined;
  toolsUsed?: ToolCallItem[] | undefined;
  actionCard?: ActionCardPayload | undefined;
  suggestedPrompts: string[];
}

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

export type ConversationDateBucket = "today" | "yesterday" | "past7Days" | "older";

export interface ConversationGroup {
  key: ConversationDateBucket;
  label: string;
  items: ChatConversationSummary[];
}

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
