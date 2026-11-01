import { BaseSqliteModule } from "../sqlite-context.js";
import {
  chatConversationSummaryFromRow,
  persistedChatMessageFromRow,
  type ChatConversationRow,
  type ChatConversationSummary,
  type ChatMessageRow,
  type CreateConversationInput,
  type PersistedChatMessage,
  type SaveChatMessageInput,
} from "../../domain/chat-conversations.js";

/**
 * AI 智能助手与对话会话专用 SQLite 持久层模块
 */
export class SqliteChatRepository extends BaseSqliteModule {
  async listConversations(input: { accountId: string }): Promise<ChatConversationSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.account_id, c.title, c.storage_id, c.created_at, c.updated_at,
                COUNT(m.id) AS message_count
         FROM chat_conversations c
         LEFT JOIN chat_messages m ON m.conversation_id = c.id AND m.account_id = c.account_id
         WHERE c.account_id = ?
         GROUP BY c.id
         ORDER BY c.updated_at DESC`,
      )
      .all(input.accountId) as ChatConversationRow[];
    return rows.map(chatConversationSummaryFromRow);
  }

  async getConversation(input: { accountId: string; id: string }): Promise<ChatConversationSummary | null> {
    const row = this.db
      .prepare(
        `SELECT c.id, c.account_id, c.title, c.storage_id, c.created_at, c.updated_at,
                COUNT(m.id) AS message_count
         FROM chat_conversations c
         LEFT JOIN chat_messages m ON m.conversation_id = c.id AND m.account_id = c.account_id
         WHERE c.id = ? AND c.account_id = ?
         GROUP BY c.id`,
      )
      .get(input.id, input.accountId) as ChatConversationRow | undefined;
    return row ? chatConversationSummaryFromRow(row) : null;
  }

  async createConversation(input: CreateConversationInput): Promise<ChatConversationSummary> {
    const id = input.id || `conv_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO chat_conversations (id, account_id, title, storage_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.accountId, input.title, input.storageId ?? null, input.now, input.now);

    return {
      id,
      accountId: input.accountId,
      title: input.title,
      storageId: input.storageId ?? null,
      messageCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  async updateConversation(input: {
    accountId: string;
    id: string;
    title?: string;
    updatedAt?: string;
  }): Promise<ChatConversationSummary | null> {
    const now = input.updatedAt ?? this.now();
    const result = this.db
      .prepare(
        `UPDATE chat_conversations
         SET title = COALESCE(?, title),
             updated_at = COALESCE(?, updated_at)
         WHERE id = ? AND account_id = ?`,
      )
      .run(input.title ?? null, now, input.id, input.accountId);
    if (result.changes === 0) return null;
    return this.getConversation({ accountId: input.accountId, id: input.id });
  }

  async deleteConversation(input: { accountId: string; id: string }): Promise<boolean> {
    return this.ctx.transaction(() => {
      this.db
        .prepare("DELETE FROM chat_messages WHERE conversation_id = ? AND account_id = ?")
        .run(input.id, input.accountId);
      const res = this.db
        .prepare("DELETE FROM chat_conversations WHERE id = ? AND account_id = ?")
        .run(input.id, input.accountId);
      return res.changes > 0;
    })();
  }

  async listMessages(input: { accountId: string; conversationId: string }): Promise<PersistedChatMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE account_id = ? AND conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(input.accountId, input.conversationId) as ChatMessageRow[];
    return rows.map(persistedChatMessageFromRow);
  }

  async saveMessage(input: SaveChatMessageInput): Promise<PersistedChatMessage> {
    return this.ctx.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_messages (id, conversation_id, account_id, role, content, thinking, tools_used, action_card, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.conversationId,
          input.accountId,
          input.role,
          input.content,
          input.thinking ?? null,
          input.toolsUsed ? JSON.stringify(input.toolsUsed) : null,
          input.actionCard ? JSON.stringify(input.actionCard) : null,
          input.createdAt,
        );

      this.db
        .prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND account_id = ?")
        .run(input.createdAt, input.conversationId, input.accountId);

      return {
        id: input.id,
        conversationId: input.conversationId,
        accountId: input.accountId,
        role: input.role,
        content: input.content,
        thinking: input.thinking ?? null,
        toolsUsed: input.toolsUsed ?? null,
        actionCard: input.actionCard ?? null,
        createdAt: input.createdAt,
      };
    })();
  }
}
