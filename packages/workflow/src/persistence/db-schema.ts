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

export interface StrmTasksTable {
  id: string;
  account_id: string;
  name: string;
  storage_id: string;
  remote_folder_id: string;
  remote_path: string;
  local_output_dir: string;
  scan_interval_minutes: number;
  scan_mode: string;
  extensions: string;
  min_file_size_mb: number;
  exclude_keywords: string | null;
  schedule_mode: string;
  status: string;
  last_scan_at: string | null;
  last_scan_status: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaServerConfigsTable {
  id: string;
  account_id: string;
  name: string;
  server_type: string;
  host_url: string;
  api_token_encrypted: string;
  path_mappings_json: string;
  is_active: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StrmLinkCacheTable {
  cache_key: string;
  download_url: string;
  delivery_mode: string;
  headers_json: string | null;
  expires_at: number;
}

export interface StrmExecutionRecordsTable {
  id: string;
  task_id: string;
  task_name: string;
  account_id: string;
  trigger_source: string;
  status: string;
  scanned_count: number;
  generated_count: number;
  updated_count: number;
  removed_count: number;
  current_progress_percent: number;
  current_step_message: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface MediaServerRefreshRecordsTable {
  id: string;
  config_id: string;
  server_name: string;
  server_type: string;
  account_id: string;
  trigger_source: string;
  target_path: string | null;
  status: string;
  sections_refreshed: string;
  refreshed_count: number;
  current_progress_percent: number;
  current_step_message: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface MediaRequestsTable {
  id: string;
  account_id: string;
  media_title_id: string;
  season_number: number | null;
  status: string;
  rejection_reason: string | null;
  workflow_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaryDatabase {
  app_settings: AppSettingsTable;
  account_settings: AccountSettingsTable;
  connected_storages: ConnectedStoragesTable;
  chat_conversations: ChatConversationsTable;
  chat_messages: ChatMessagesTable;
  strm_tasks: StrmTasksTable;
  mediaserver_configs: MediaServerConfigsTable;
  strm_link_cache: StrmLinkCacheTable;
  strm_execution_records: StrmExecutionRecordsTable;
  mediaserver_refresh_records: MediaServerRefreshRecordsTable;
  media_requests: MediaRequestsTable;
}
