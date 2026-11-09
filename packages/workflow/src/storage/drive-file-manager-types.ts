export type DriveItemType = "folder" | "video" | "subtitle" | "audio" | "archive" | "image" | "file";

export interface DriveFileMediaInfo {
  parsedTitle?: string | undefined;
  parsedYear?: number | undefined;
  parsedSeason?: number | undefined;
  tmdbId?: number | undefined;
  confidence: number;
  isSubscribed?: boolean | undefined;
  subscriptionStatus?: "active" | "completed" | undefined;
}

export interface DriveFileItem {
  id: string;
  name: string;
  isFolder: boolean;
  type: DriveItemType;
  sizeBytes: number;
  updatedAt: string | null;
  extension: string;
  mediaInfo?: DriveFileMediaInfo | undefined;
}

export interface DriveBreadcrumb {
  id: string;
  name: string;
}

export interface DriveDirectoryListing {
  storageId: string;
  provider: string;
  currentDirectoryId: string;
  currentDirectoryName: string;
  items: DriveFileItem[];
  totalCount: number;
  folderCount: number;
  fileCount: number;
  totalSizeBytes: number;
  breadcrumbs: DriveBreadcrumb[];
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}

export interface DriveFileManager {
  listDirectory(directoryId?: string): Promise<DriveDirectoryListing>;
  createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }>;
  renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void>;
  deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }>;
  moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }>;
  copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }>;
}

export interface DriveFileManagerOptions {
  storageId: string;
  provider: string;
  cookie?: string;
  credential?: unknown;
  rootCid?: string | null;
  moviesCid?: string | null;
  tvCid?: string | null;
  animeCid?: string | null;
}
