import type Database from "better-sqlite3";

/**
 * 敏感设置键注册表（任务单 S1.5，P15）。命中的值落盘前经 AES-256-GCM 加密；
 * 其余配置（URL、模型 id、开关、时间戳……）保持明文，便于排障与迁移。
 * `push_*` 整族都是推送通道凭据（Server酱 sendkey / Bark / Webhook …）。
 */
export const SECRET_SETTING_KEYS = new Set([
  "api_key", // S5.2：API Key（换 JWT 的长期凭据）
  "jwt_secret", // S5.3：JWT 签名 secret
  "pan115.cookie",
  "session_secret",
  "agent_api_token",
  "assrt_token",
  "connect_instance_credential",
  "connect_tunnel_token",
  "jev_api_key",
  "llm_api_key",
  "prowlarr_api_key",
  "tmdb_api_key",
]);

export function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEYS.has(key) || key.startsWith("push_");
}

/**
 * The single SQLite schema (pure-SQLite single engine, task S1.4b — the Postgres
 * twin and its migration chain were removed with it). `text` payload columns hold
 * JSON.stringify'd objects (SQLite has no jsonb). The tree-model scope columns
 * (account_id, connected_storage_id) and the composite primary keys are declared
 * inline: a fresh SQLite database needs the FINAL shape up front, not migration
 * steps. The acct_default seed row matches what the old twin produced.
 */
export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_titles (
    id text PRIMARY KEY,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracked_seasons (
    id text NOT NULL,
    media_title_id text NOT NULL,
    account_id text NOT NULL DEFAULT 'acct_default',
    connected_storage_id text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (id, connected_storage_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_seasons_title
    ON tracked_seasons (media_title_id);
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id text PRIMARY KEY,
    tracked_season_id text NOT NULL,
    account_id text NOT NULL DEFAULT 'acct_default',
    connected_storage_id text NOT NULL,
    payload text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope_season
    ON workflow_runs (account_id, connected_storage_id, tracked_season_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_season_storage
    ON workflow_runs (tracked_season_id, connected_storage_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_queue_claim
    ON workflow_runs (json_extract(payload, '$.status'), json_extract(payload, '$.kind'), json_extract(payload, '$.startedAt'));
  CREATE TABLE IF NOT EXISTS episode_states (
    tracked_season_id text NOT NULL,
    connected_storage_id text NOT NULL,
    episode_code text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (tracked_season_id, connected_storage_id, episode_code)
  );
  CREATE TABLE IF NOT EXISTS resource_snapshots (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_resource_snapshots_run
    ON resource_snapshots (workflow_run_id, ordinal);
  CREATE TABLE IF NOT EXISTS agent_decisions (
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    snapshot_id text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS agent_steps (
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS transfer_attempts (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    candidate_id text NOT NULL,
    payload text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transfer_attempts_run
    ON transfer_attempts (workflow_run_id, ordinal);
  CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_run
    ON notifications (workflow_run_id, ordinal);
  CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY,
    value text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (account_id, key)
  );
  CREATE TABLE IF NOT EXISTS dead_links (
    key text PRIMARY KEY,
    kind text NOT NULL,
    reason text NOT NULL,
    permanent integer NOT NULL DEFAULT 1,
    expires_at text,
    recorded_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_memories (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    scope text NOT NULL,
    title_key text NOT NULL DEFAULT '',
    name text NOT NULL,
    description text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    provider text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    last_used_at text,
    source_run_id text,
    UNIQUE (account_id, scope, title_key, name)
  );
  CREATE TABLE IF NOT EXISTS user_messages (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    body text NOT NULL,
    episode_tags text NOT NULL DEFAULT '[]',
    status text NOT NULL,
    urgent integer NOT NULL DEFAULT 0,
    run_id text,
    reply text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    processed_at text
  );
  CREATE INDEX IF NOT EXISTS user_messages_work ON user_messages (account_id, drive, title_key, status);
  CREATE INDEX IF NOT EXISTS user_messages_pending ON user_messages (status, urgent);
  CREATE INDEX IF NOT EXISTS user_messages_run ON user_messages (run_id);
  CREATE TABLE IF NOT EXISTS pending_replacements (
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    episode text NOT NULL,
    message_id text NOT NULL,
    requested_at text NOT NULL,
    PRIMARY KEY (account_id, drive, title_key, episode)
  );
  CREATE TABLE IF NOT EXISTS rejected_resources (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    title_key text NOT NULL,
    episode text NOT NULL,
    link_key text,
    label text NOT NULL,
    size_bytes integer,
    reason text NOT NULL,
    message_id text,
    created_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rejected_resources_work ON rejected_resources (account_id, title_key);
  -- 批次 5：订阅策略层（plan §4.1 四件套 ③「独立策略表」）。**刻意不加 status 列**——
  -- 一个策略是偏好，不是状态机。词表存 JSON（一行一条策略）；use_regex 存 0/1
  -- （SQLite 无布尔量）。
  CREATE TABLE IF NOT EXISTS subscription_policies (
    account_id text NOT NULL,
    title_key text NOT NULL,
    must_contain text NOT NULL DEFAULT '[]',
    must_not_contain text NOT NULL DEFAULT '[]',
    episode_filter text NOT NULL DEFAULT '',
    use_regex integer NOT NULL DEFAULT 0,
    cooldown_days integer NOT NULL DEFAULT 0,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    -- cooldownDays 的水位线：这条策略最后一次被采纳的时间。刻意与 updated_at 分开——
    -- 后者是用户改规则的时间，拿它当水位线会让每次编辑都看起来像刚匹配过。
    last_taken_at text,
    custom_keywords text NOT NULL DEFAULT '[]',
    PRIMARY KEY (account_id, title_key)
  );
  CREATE TABLE IF NOT EXISTS episode_sources (
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    episode text NOT NULL,
    link_key text,
    label text NOT NULL,
    size_bytes integer,
    run_id text NOT NULL,
    recorded_at text NOT NULL,
    PRIMARY KEY (account_id, drive, title_key, episode)
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id text PRIMARY KEY,
    username text UNIQUE NOT NULL,
    password_hash text NOT NULL DEFAULT '',
    group_id text,
    is_owner integer NOT NULL DEFAULT 0,
    created_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_account_expires
    ON sessions (account_id, expires_at);
  CREATE TABLE IF NOT EXISTS connected_storages (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    provider text NOT NULL,
    provider_uid text NOT NULL,
    label text,
    payload text NOT NULL,
    root_cid text,
    movies_cid text,
    tv_cid text,
    anime_cid text,
    status text NOT NULL DEFAULT 'active',
    frozen_reason text,
    frozen_at text,
    created_at text NOT NULL,
    UNIQUE (provider, provider_uid)
  );
  CREATE INDEX IF NOT EXISTS idx_connected_storages_account
    ON connected_storages (account_id, created_at);
  CREATE TABLE IF NOT EXISTS pan115_oauth_refresh_leases (
    storage_id text PRIMARY KEY,
    owner_id text NOT NULL,
    lease_expires_at integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    title text NOT NULL,
    storage_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_conversations_account
    ON chat_conversations (account_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id text PRIMARY KEY,
    conversation_id text NOT NULL,
    account_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    thinking text,
    tools_used text,
    action_card text,
    created_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
    ON chat_messages (conversation_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_account
    ON chat_messages (account_id);
  CREATE TABLE IF NOT EXISTS strm_tasks (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    name text NOT NULL,
    storage_id text NOT NULL,
    remote_folder_id text NOT NULL,
    remote_path text NOT NULL,
    local_output_dir text NOT NULL,
    scan_interval_minutes integer DEFAULT 360,
    scan_mode text DEFAULT 'incremental_missing',
    extensions text DEFAULT 'mp4;mkv;ts;avi;mov;wmv;iso;flv',
    min_file_size_mb integer DEFAULT 100,
    exclude_keywords text,
    schedule_mode text DEFAULT 'interval',
    status text DEFAULT 'idle',
    delivery_mode text DEFAULT 'redirect',
    media_server_id text,
    media_library_id text,
    media_library_name text,
    last_scan_at text,
    last_scan_status text,
    last_error_message text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_strm_tasks_account
    ON strm_tasks (account_id, created_at);
  CREATE TABLE IF NOT EXISTS mediaserver_configs (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    name text NOT NULL,
    server_type text NOT NULL,
    host_url text NOT NULL,
    api_token_encrypted text NOT NULL,
    path_mappings_json text NOT NULL,
    detected_libraries_json text DEFAULT '[]',
    is_active integer DEFAULT 1,
    last_sync_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mediaserver_configs_account
    ON mediaserver_configs (account_id, created_at);
  CREATE TABLE IF NOT EXISTS strm_link_cache (
    cache_key text PRIMARY KEY,
    download_url text NOT NULL,
    delivery_mode text NOT NULL,
    headers_json text,
    expires_at integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_strm_link_cache_expires
    ON strm_link_cache (expires_at);
  CREATE TABLE IF NOT EXISTS strm_execution_records (
    id text PRIMARY KEY,
    task_id text NOT NULL,
    task_name text NOT NULL,
    account_id text NOT NULL,
    trigger_source text NOT NULL,
    status text NOT NULL,
    scanned_count integer DEFAULT 0,
    generated_count integer DEFAULT 0,
    updated_count integer DEFAULT 0,
    removed_count integer DEFAULT 0,
    current_progress_percent integer DEFAULT 0,
    current_step_message text,
    error_message text,
    started_at text NOT NULL,
    finished_at text,
    duration_ms integer
  );
  CREATE INDEX IF NOT EXISTS idx_strm_records_task
    ON strm_execution_records (task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_strm_records_account
    ON strm_execution_records (account_id, started_at);
  CREATE TABLE IF NOT EXISTS mediaserver_refresh_records (
    id text PRIMARY KEY,
    config_id text NOT NULL,
    server_name text NOT NULL,
    server_type text NOT NULL,
    account_id text NOT NULL,
    trigger_source text NOT NULL,
    target_path text,
    status text NOT NULL,
    sections_refreshed text,
    refreshed_count integer DEFAULT 0,
    current_progress_percent integer DEFAULT 0,
    current_step_message text,
    error_message text,
    started_at text NOT NULL,
    finished_at text,
    duration_ms integer
  );
  CREATE INDEX IF NOT EXISTS idx_ms_records_config
    ON mediaserver_refresh_records (config_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_ms_records_account
    ON mediaserver_refresh_records (account_id, started_at);
  CREATE TABLE IF NOT EXISTS media_requests (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    media_title_id text NOT NULL,
    season_number integer,
    status text NOT NULL DEFAULT 'queued',
    rejection_reason text,
    workflow_run_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_requests_user
    ON media_requests (account_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_requests_media
    ON media_requests (media_title_id, season_number);
  CREATE INDEX IF NOT EXISTS idx_media_requests_run
    ON media_requests (workflow_run_id);
  CREATE TABLE IF NOT EXISTS reverse_scan_jobs (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    storage_id text NOT NULL,
    target_cid text NOT NULL,
    category text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    total_folders integer DEFAULT 0,
    scanned_folders integer DEFAULT 0,
    discovered_titles integer DEFAULT 0,
    auto_ingested_titles integer DEFAULT 0,
    pending_review_titles integer DEFAULT 0,
    current_step_message text,
    progress_percent integer DEFAULT 0,
    error_message text,
    started_at text,
    finished_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reverse_scan_jobs_account
    ON reverse_scan_jobs (account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS reverse_scan_items (
    id text PRIMARY KEY,
    job_id text NOT NULL,
    account_id text NOT NULL,
    folder_id text NOT NULL,
    folder_name text NOT NULL,
    relative_path text NOT NULL,
    parsed_title text,
    parsed_year integer,
    matched_tmdb_id integer,
    matched_media_type text,
    matched_title text,
    matched_poster_path text,
    confidence integer NOT NULL DEFAULT 0,
    review_status text NOT NULL DEFAULT 'auto_accepted',
    discovered_files_json text DEFAULT '[]',
    reconciled_seasons_json text,
    error_reason text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reverse_scan_items_job
    ON reverse_scan_items (job_id, review_status);
  INSERT INTO accounts (id, username, password_hash, is_owner, created_at)
    VALUES ('acct_default', 'default', '', 1, '1970-01-01T00:00:00.000Z')
    ON CONFLICT (id) DO NOTHING;
`;

/**
 * 补上早于 last_taken_at 的库缺的列。
 */
export function upgradeSubscriptionPolicyShape(db: Database.Database): void {
  const cols = db.pragma("table_info(subscription_policies)") as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "last_taken_at")) {
    db.exec("ALTER TABLE subscription_policies ADD COLUMN last_taken_at text");
  }
  if (!cols.some((c) => c.name === "custom_keywords")) {
    db.exec("ALTER TABLE subscription_policies ADD COLUMN custom_keywords text NOT NULL DEFAULT '[]'");
  }
}

/**
 * 补上早于 delivery_mode 的库缺的列。
 */
export function upgradeStrmTasksShape(db: Database.Database): void {
  const cols = db.pragma("table_info(strm_tasks)") as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "delivery_mode")) {
    db.exec("ALTER TABLE strm_tasks ADD COLUMN delivery_mode text DEFAULT 'redirect'");
  }
  if (!cols.some((c) => c.name === "media_server_id")) {
    db.exec("ALTER TABLE strm_tasks ADD COLUMN media_server_id text");
  }
  if (!cols.some((c) => c.name === "media_library_id")) {
    db.exec("ALTER TABLE strm_tasks ADD COLUMN media_library_id text");
  }
  if (!cols.some((c) => c.name === "media_library_name")) {
    db.exec("ALTER TABLE strm_tasks ADD COLUMN media_library_name text");
  }
}

/**
 * 补上早于 detected_libraries_json 的库缺的列。
 */
export function upgradeMediaserverConfigsShape(db: Database.Database): void {
  const cols = db.pragma("table_info(mediaserver_configs)") as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "detected_libraries_json")) {
    db.exec("ALTER TABLE mediaserver_configs ADD COLUMN detected_libraries_json text DEFAULT '[]'");
  }
}
