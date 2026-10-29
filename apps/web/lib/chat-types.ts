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
