/**
 * 网盘统一驱动端口（对标 AList 适配器抽象）。
 *
 * 规约：Features 只能依赖本端口，严禁直接 import Infrastructure 里的具体驱动实现
 * （见 docs/architecture-remediation-and-governance.md §3.3 依赖方向铁律）。
 */

export interface FileMetadata {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly isFolder: boolean;
  readonly extension?: string;
}

export type StorageBrand = "pan115" | "quark" | "pan123" | "guangya" | "tianyi";

export interface IStorageDriver {
  readonly brand: StorageBrand;

  /** 连通性与凭据 */
  ping(): Promise<boolean>;
  refreshToken(): Promise<void>;

  /** 目录操作 */
  ensureDir(parentId: string, dirName: string): Promise<string>;
  listChildren(dirId: string): Promise<FileMetadata[]>;

  /** 文件流转（支持批量） */
  moveFiles(fileIds: readonly string[], targetDirId: string): Promise<void>;
  deleteFiles(fileIds: readonly string[]): Promise<void>;

  /** 核心转存 / 离线能力 */
  transferShare(shareUrl: string, targetDirId: string, password?: string): Promise<string>;
  addOfflineTask(url: string, targetDirId: string): Promise<string>;
  queryTaskStatus(taskId: string): Promise<"pending" | "downloading" | "succeeded" | "failed">;
}
