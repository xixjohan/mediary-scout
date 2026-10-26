/**
 * API Key 存储端口（S5.2）。
 *
 * 纯 SQLite 实现见 packages/workflow/src/sqlite.ts（值落在 app_settings，
 * 由 SECRET_SETTING_KEYS 透明 AES-256-GCM 加密）。端口保持中立：
 * 不绑定 better-sqlite3，也不绑定任何配置中心。
 *
 * 优先级语义（数据库 > 环境变量）在 shared 的 resolveApiKey 里，
 * 实现方只负责读写自己那一份。
 */
export interface IApiKeyStore {
  /** 读当前存储的值；未设置返回 null */
  get(): string | null;
  /** 写入（覆盖）；空串视为清除，由实现方决定归一化 */
  set(value: string): void;
  /** 清除存储的值 */
  clear(): void;
}
