/**
 * 媒体服务器领域核心类型定义
 */

export type MediaServerType = "plex" | "emby" | "jellyfin";

export interface PathMapping {
  id: string;
  localPath: string;    // 本地 STRM 目录，如 /data/strm/movies
  remotePath: string;   // 媒体服务器内路径，如 /media/movies
}

export interface MediaServerConfig {
  id: string;
  accountId: string;
  name: string;
  serverType: MediaServerType;
  hostUrl: string;
  apiTokenEncrypted: string;
  pathMappings: PathMapping[];
  isActive: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMediaServerConfigInput {
  id?: string;
  accountId: string;
  name: string;
  serverType: MediaServerType;
  hostUrl: string;
  apiToken: string; // 明文，保存时加密
  pathMappings?: PathMapping[];
  isActive?: boolean;
}

export interface UpdateMediaServerConfigInput {
  id: string;
  accountId: string;
  name?: string;
  serverType?: MediaServerType;
  hostUrl?: string;
  apiToken?: string; // 明文，若传入则重新加密
  pathMappings?: PathMapping[];
  isActive?: boolean;
  lastSyncAt?: string | null;
}

export interface MediaLibrary {
  id: string;
  name: string;
  type: "movie" | "show" | "other";
  locations: string[]; // 挂载路径
}

export interface MediaServerConnectionStatus {
  ok: boolean;
  version?: string | undefined;
  serverName?: string | undefined;
  errorMessage?: string | undefined;
}

export interface MediaServerRefreshResult {
  ok: boolean;
  refreshedCount: number;
  sectionsRefreshed: string[];
  errorMessage?: string | undefined;
}

export interface MediaServerRefreshRecord {
  id: string;
  configId: string;
  serverName: string;
  serverType: MediaServerType;
  accountId: string;
  triggerSource: "manual" | "strm_sync" | "debounced_queue" | "pinpoint_ingest";
  targetPath: string | null;
  status: "running" | "succeeded" | "failed";
  sectionsRefreshed: string[];
  refreshedCount: number;
  currentProgressPercent: number;
  currentStepMessage: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface CreateMediaServerRefreshRecordInput {
  id?: string | undefined;
  configId: string;
  serverName: string;
  serverType: MediaServerType;
  accountId: string;
  triggerSource: "manual" | "strm_sync" | "debounced_queue" | "pinpoint_ingest";
  targetPath?: string | null | undefined;
  status?: ("running" | "succeeded" | "failed") | undefined;
  sectionsRefreshed?: string[] | undefined;
  refreshedCount?: number | undefined;
  currentProgressPercent?: number | undefined;
  currentStepMessage?: string | null | undefined;
  errorMessage?: string | null | undefined;
  startedAt?: string | undefined;
}

export interface UpdateMediaServerRefreshRecordInput {
  id: string;
  status?: ("running" | "succeeded" | "failed") | undefined;
  sectionsRefreshed?: string[] | undefined;
  refreshedCount?: number | undefined;
  currentProgressPercent?: number | undefined;
  currentStepMessage?: string | null | undefined;
  errorMessage?: string | null | undefined;
  finishedAt?: string | null | undefined;
  durationMs?: number | null | undefined;
}

export interface MediaServerStore {
  listMediaServerConfigs(accountId: string): Promise<MediaServerConfig[]>;
  getMediaServerConfig(id: string, accountId: string): Promise<MediaServerConfig | null>;
  createMediaServerConfig(input: CreateMediaServerConfigInput): Promise<MediaServerConfig>;
  updateMediaServerConfig(input: UpdateMediaServerConfigInput): Promise<MediaServerConfig | null>;
  deleteMediaServerConfig(id: string, accountId: string): Promise<boolean>;

  createMediaServerRefreshRecord(input: CreateMediaServerRefreshRecordInput): Promise<MediaServerRefreshRecord>;
  updateMediaServerRefreshRecord(input: UpdateMediaServerRefreshRecordInput): Promise<MediaServerRefreshRecord | null>;
  listMediaServerRefreshRecords(configId: string, accountId: string, limit?: number): Promise<MediaServerRefreshRecord[]>;
  getLatestMediaServerRefreshRecord(configId: string, accountId: string): Promise<MediaServerRefreshRecord | null>;
}
