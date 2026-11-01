import { encryptSecret } from "@media-track/shared";
import { BaseSqliteModule } from "../sqlite-context.js";
import type {
  CreateMediaServerConfigInput,
  CreateMediaServerRefreshRecordInput,
  MediaServerConfig,
  MediaServerRefreshRecord,
  MediaServerStore,
  UpdateMediaServerConfigInput,
  UpdateMediaServerRefreshRecordInput,
} from "../../mediaserver/mediaserver-types.js";

interface MediaServerConfigRow {
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

function mediaServerConfigFromRow(row: MediaServerConfigRow): MediaServerConfig {
  let mappings = [];
  try {
    mappings = JSON.parse(row.path_mappings_json);
  } catch {
    mappings = [];
  }
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    serverType: row.server_type as MediaServerConfig["serverType"],
    hostUrl: row.host_url,
    apiTokenEncrypted: row.api_token_encrypted,
    pathMappings: mappings,
    isActive: row.is_active === 1,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MediaServerRefreshRecordRow {
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

function mediaServerRefreshRecordFromRow(row: MediaServerRefreshRecordRow): MediaServerRefreshRecord {
  let sections: string[] = [];
  try {
    sections = JSON.parse(row.sections_refreshed);
  } catch {
    sections = [];
  }
  return {
    id: row.id,
    configId: row.config_id,
    serverName: row.server_name,
    serverType: row.server_type as MediaServerRefreshRecord["serverType"],
    accountId: row.account_id,
    triggerSource: row.trigger_source as MediaServerRefreshRecord["triggerSource"],
    targetPath: row.target_path,
    status: row.status as MediaServerRefreshRecord["status"],
    sectionsRefreshed: sections,
    refreshedCount: row.refreshed_count,
    currentProgressPercent: row.current_progress_percent,
    currentStepMessage: row.current_step_message,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

/**
 * 媒体服务器配置与刷新执行记录专用 SQLite 持久层模块
 */
export class SqliteMediaServerRepository extends BaseSqliteModule implements MediaServerStore {
  async listMediaServerConfigs(accountId: string): Promise<MediaServerConfig[]> {
    const rows = this.db
      .prepare("SELECT * FROM mediaserver_configs WHERE account_id = ? ORDER BY created_at DESC")
      .all(accountId) as MediaServerConfigRow[];
    return rows.map(mediaServerConfigFromRow);
  }

  async getMediaServerConfig(id: string, accountId: string): Promise<MediaServerConfig | null> {
    const row = this.db
      .prepare("SELECT * FROM mediaserver_configs WHERE id = ? AND account_id = ?")
      .get(id, accountId) as MediaServerConfigRow | undefined;
    return row ? mediaServerConfigFromRow(row) : null;
  }

  async createMediaServerConfig(input: CreateMediaServerConfigInput): Promise<MediaServerConfig> {
    const id = input.id ?? `ms_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = this.now();
    const tokenEncrypted = encryptSecret(input.apiToken);
    const pathMappingsJson = JSON.stringify(input.pathMappings ?? []);
    const isActive = input.isActive !== false ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO mediaserver_configs (
          id, account_id, name, server_type, host_url, api_token_encrypted,
          path_mappings_json, is_active, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
      )
      .run(
        id,
        input.accountId,
        input.name,
        input.serverType,
        input.hostUrl.replace(/\/+$/, ""),
        tokenEncrypted,
        pathMappingsJson,
        isActive,
        now,
        now,
      );

    return {
      id,
      accountId: input.accountId,
      name: input.name,
      serverType: input.serverType,
      hostUrl: input.hostUrl.replace(/\/+$/, ""),
      apiTokenEncrypted: tokenEncrypted,
      pathMappings: input.pathMappings ?? [],
      isActive: isActive === 1,
      lastSyncAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateMediaServerConfig(input: UpdateMediaServerConfigInput): Promise<MediaServerConfig | null> {
    const current = await this.getMediaServerConfig(input.id, input.accountId);
    if (!current) return null;

    const now = this.now();
    const tokenEncrypted = input.apiToken ? encryptSecret(input.apiToken) : current.apiTokenEncrypted;
    const pathMappings = input.pathMappings ?? current.pathMappings;
    const pathMappingsJson = JSON.stringify(pathMappings);
    const hostUrl = input.hostUrl ? input.hostUrl.replace(/\/+$/, "") : current.hostUrl;
    const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : (current.isActive ? 1 : 0);
    const lastSyncAt = input.lastSyncAt !== undefined ? input.lastSyncAt : current.lastSyncAt;

    this.db
      .prepare(
        `UPDATE mediaserver_configs SET
          name = ?, server_type = ?, host_url = ?, api_token_encrypted = ?,
          path_mappings_json = ?, is_active = ?, last_sync_at = ?, updated_at = ?
        WHERE id = ? AND account_id = ?`,
      )
      .run(
        input.name ?? current.name,
        input.serverType ?? current.serverType,
        hostUrl,
        tokenEncrypted,
        pathMappingsJson,
        isActive,
        lastSyncAt,
        now,
        input.id,
        input.accountId,
      );

    return {
      ...current,
      name: input.name ?? current.name,
      serverType: input.serverType ?? current.serverType,
      hostUrl,
      apiTokenEncrypted: tokenEncrypted,
      pathMappings,
      isActive: isActive === 1,
      lastSyncAt,
      updatedAt: now,
    };
  }

  async deleteMediaServerConfig(id: string, accountId: string): Promise<boolean> {
    const res = this.db.prepare("DELETE FROM mediaserver_configs WHERE id = ? AND account_id = ?").run(id, accountId);
    return res.changes > 0;
  }

  async createMediaServerRefreshRecord(
    input: CreateMediaServerRefreshRecordInput,
  ): Promise<MediaServerRefreshRecord> {
    const id = input.id ?? `ms_rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = input.startedAt ?? this.now();
    const record: MediaServerRefreshRecord = {
      id,
      configId: input.configId,
      serverName: input.serverName,
      serverType: input.serverType,
      accountId: input.accountId,
      triggerSource: input.triggerSource,
      targetPath: input.targetPath ?? null,
      status: input.status ?? "running",
      sectionsRefreshed: input.sectionsRefreshed ?? [],
      refreshedCount: input.refreshedCount ?? 0,
      currentProgressPercent: input.currentProgressPercent ?? 0,
      currentStepMessage: input.currentStepMessage ?? null,
      errorMessage: input.errorMessage ?? null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    };

    this.db
      .prepare(
        `INSERT INTO mediaserver_refresh_records (
          id, config_id, server_name, server_type, account_id, trigger_source,
          target_path, status, sections_refreshed, refreshed_count,
          current_progress_percent, current_step_message, error_message,
          started_at, finished_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)`,
      )
      .run(
        record.id,
        record.configId,
        record.serverName,
        record.serverType,
        record.accountId,
        record.triggerSource,
        record.targetPath,
        record.status,
        JSON.stringify(record.sectionsRefreshed),
        record.refreshedCount,
        record.currentProgressPercent,
        record.currentStepMessage,
        record.errorMessage,
        record.startedAt,
      );

    return record;
  }

  async updateMediaServerRefreshRecord(
    input: UpdateMediaServerRefreshRecordInput,
  ): Promise<MediaServerRefreshRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM mediaserver_refresh_records WHERE id = ?")
      .get(input.id) as MediaServerRefreshRecordRow | undefined;
    if (!row) return null;

    const current = mediaServerRefreshRecordFromRow(row);
    const updated: MediaServerRefreshRecord = {
      ...current,
      status: input.status ?? current.status,
      sectionsRefreshed: input.sectionsRefreshed ?? current.sectionsRefreshed,
      refreshedCount: input.refreshedCount ?? current.refreshedCount,
      currentProgressPercent: input.currentProgressPercent ?? current.currentProgressPercent,
      currentStepMessage: input.currentStepMessage !== undefined ? input.currentStepMessage : current.currentStepMessage,
      errorMessage: input.errorMessage !== undefined ? input.errorMessage : current.errorMessage,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (input.status === "succeeded" || input.status === "failed" ? this.now() : current.finishedAt),
      durationMs: input.durationMs !== undefined ? input.durationMs : current.durationMs,
    };

    this.db
      .prepare(
        `UPDATE mediaserver_refresh_records SET
          status = ?, sections_refreshed = ?, refreshed_count = ?,
          current_progress_percent = ?, current_step_message = ?, error_message = ?,
          finished_at = ?, duration_ms = ?
        WHERE id = ?`,
      )
      .run(
        updated.status,
        JSON.stringify(updated.sectionsRefreshed),
        updated.refreshedCount,
        updated.currentProgressPercent,
        updated.currentStepMessage,
        updated.errorMessage,
        updated.finishedAt,
        updated.durationMs,
        updated.id,
      );

    return updated;
  }

  async getMediaServerRefreshRecord(id: string, accountId: string): Promise<MediaServerRefreshRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM mediaserver_refresh_records WHERE id = ? AND account_id = ?")
      .get(id, accountId) as MediaServerRefreshRecordRow | undefined;
    return row ? mediaServerRefreshRecordFromRow(row) : null;
  }

  async listMediaServerRefreshRecords(
    configId: string,
    accountId: string,
    limit = 50,
  ): Promise<MediaServerRefreshRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM mediaserver_refresh_records WHERE config_id = ? AND account_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(configId, accountId, limit) as MediaServerRefreshRecordRow[];
    return rows.map(mediaServerRefreshRecordFromRow);
  }

  async getLatestMediaServerRefreshRecord(
    configId: string,
    accountId: string,
  ): Promise<MediaServerRefreshRecord | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM mediaserver_refresh_records WHERE config_id = ? AND account_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(configId, accountId) as MediaServerRefreshRecordRow | undefined;
    return row ? mediaServerRefreshRecordFromRow(row) : null;
  }
}
