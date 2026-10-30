/**
 * Kysely 类型安全数据库 Schema（任务单 S1.6，P3 收尾）。
 *
 * 这是表结构的单一 TypeScript 事实源：列名/类型在此声明一次，查询构建器
 * 在编译期检查列名与比较运算，消灭手写 SQL 的拼写/方言错误。
 * 权威 DDL 仍是 sqlite.ts 的 SQLITE_SCHEMA（本文件与其保持一致；
 * tests/credential-store.test.ts 用 SQLITE_SCHEMA 建表后驱动本 schema）。
 */

import type { Generated } from "kysely";

/** app_settings：全局键值（含 pan115.cookie / session_secret 等敏感项）。 */
export interface AppSettingsTable {
  key: string;
  value: string;
}

/** account_settings：按账号的键值（LLM/TMDB/push_* 等）。 */
export interface AccountSettingsTable {
  account_id: string;
  key: string;
  value: string;
}

/** connected_storages：账号绑定的网盘（payload 落盘为 AES-256-GCM 密文）。 */
export interface ConnectedStoragesTable {
  id: string;
  account_id: string;
  provider: string;
  provider_uid: string;
  label: string | null;
  payload: string;
  root_cid: string | null;
  movies_cid: string | null;
  tv_cid: string | null;
  anime_cid: string | null;
  /** DB DEFAULT 'active' —— 插入时可省略。 */
  status: Generated<string>;
  frozen_reason: string | null;
  frozen_at: string | null;
  created_at: string;
}

export interface ChatConversationsTable {
  id: string;
  account_id: string;
  title: string;
  storage_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessagesTable {
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

export interface MediaryDatabase {
  app_settings: AppSettingsTable;
  account_settings: AccountSettingsTable;
  connected_storages: ConnectedStoragesTable;
  chat_conversations: ChatConversationsTable;
  chat_messages: ChatMessagesTable;
}
