import { Pan115CookieClient } from "./pan115-cookie-client.js";
import { QuarkCookieClient } from "./quark-cookie-client.js";
import { Pan123Client } from "./pan123-client.js";
import { TianyiClient } from "./tianyi-client.js";
import { GuangYaClient } from "./guangya-client.js";

export type DriveItemType = "folder" | "video" | "subtitle" | "audio" | "archive" | "image" | "file";

export interface DriveFileItem {
  id: string;
  name: string;
  isFolder: boolean;
  type: DriveItemType;
  sizeBytes: number;
  updatedAt: string | null;
  extension: string;
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

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".rmvb", ".ts", ".m2ts", ".webm", ".iso", ".m4v",
]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".sup"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".aac", ".m4a", ".ogg", ".opus", ".ape"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".xz", ".bz2"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

export function inferExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return "";
  return fileName.slice(lastDot).toLowerCase();
}

export function inferFileType(fileName: string, isFolder: boolean): DriveItemType {
  if (isFolder) return "folder";
  const ext = inferExtension(fileName);
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "file";
}

export function resolveCurrentDirectoryName(
  dirId: string,
  opts: {
    rootCid?: string | null;
    moviesCid?: string | null;
    tvCid?: string | null;
    animeCid?: string | null;
  },
): string {
  if (opts.moviesCid && dirId === opts.moviesCid) return "电影";
  if (opts.tvCid && dirId === opts.tvCid) return "剧集";
  if (opts.animeCid && dirId === opts.animeCid) return "动漫";
  if (!dirId || dirId === "0" || dirId === opts.rootCid) return "根目录";
  return `目录 (${dirId.slice(0, 8)}…)`;
}

function summarizeItems(items: DriveFileItem[]): {
  folderCount: number;
  fileCount: number;
  totalSizeBytes: number;
} {
  let folderCount = 0;
  let fileCount = 0;
  let totalSizeBytes = 0;

  for (const item of items) {
    if (item.isFolder) {
      folderCount += 1;
    } else {
      fileCount += 1;
      totalSizeBytes += item.sizeBytes;
    }
  }

  return { folderCount, fileCount, totalSizeBytes };
}

function sortDriveItems(items: DriveFileItem[]): DriveFileItem[] {
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
  });
}

function buildListing(
  opts: DriveFileManagerOptions,
  dirId: string,
  rawItems: DriveFileItem[],
): DriveDirectoryListing {
  const items = sortDriveItems(rawItems);
  const summary = summarizeItems(items);
  const dirName = resolveCurrentDirectoryName(dirId, opts);

  const breadcrumbs: DriveBreadcrumb[] = [
    { id: opts.rootCid || "0", name: "根目录" },
  ];
  if (dirId !== (opts.rootCid || "0")) {
    breadcrumbs.push({ id: dirId, name: dirName });
  }

  return {
    storageId: opts.storageId,
    provider: opts.provider,
    currentDirectoryId: dirId,
    currentDirectoryName: dirName,
    items,
    totalCount: items.length,
    folderCount: summary.folderCount,
    fileCount: summary.fileCount,
    totalSizeBytes: summary.totalSizeBytes,
    breadcrumbs,
    rootCid: opts.rootCid ?? null,
    moviesCid: opts.moviesCid ?? null,
    tvCid: opts.tvCid ?? null,
    animeCid: opts.animeCid ?? null,
  };
}

export class QuarkFileManagerAdapter implements DriveFileManager {
  private readonly client: QuarkCookieClient;
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    this.client = new QuarkCookieClient({ cookie: opts.cookie ?? "" });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "0";
    const raw = await this.client.listItems({ directoryId: targetDir });
    const items: DriveFileItem[] = raw.map((r) => {
      const isFolder = Boolean(r.dir);
      const name = r.file_name ?? "";
      return {
        id: r.fid ?? "",
        name,
        isFolder,
        type: inferFileType(name, isFolder),
        sizeBytes: typeof r.size === "number" ? r.size : Number(r.size || 0),
        updatedAt: null,
        extension: inferExtension(name),
      };
    });
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = await this.client.createFolder({ name: input.name, parentId: input.parentId });
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    await this.client.renameFile({ fid: input.itemId, name: input.newName });
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    const fids = items.map((i) => i.id).filter(Boolean);
    if (fids.length > 0) {
      await this.client.deleteFiles(fids);
    }
    return { deletedCount: fids.length };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    const fids = input.items.map((i) => i.id).filter(Boolean);
    if (fids.length > 0) {
      await this.client.moveFiles({ fids, to: input.targetDirectoryId });
    }
    return { movedCount: fids.length };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    const fids = input.items.map((i) => i.id).filter(Boolean);
    if (fids.length > 0) {
      await this.client.copyFiles({ fids, to: input.targetDirectoryId });
    }
    return { copiedCount: fids.length };
  }
}

export class Pan115FileManagerAdapter implements DriveFileManager {
  private readonly client: Pan115CookieClient;
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    this.client = new Pan115CookieClient({ cookie: opts.cookie ?? "" });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "0";
    const raw = await this.client.listItems({ directoryId: targetDir });
    const items: DriveFileItem[] = raw.map((r) => {
      const isFolder = r.fc === 0 || r.fc === "0" || (r.cid !== undefined && r.fid === undefined && r.file_id === undefined);
      const id = String(isFolder ? (r.cid ?? r.id) : (r.fid ?? r.file_id ?? r.id));
      const name = String(r.name ?? r.n ?? "");
      const sizeBytes = Number(r.size ?? r.s ?? 0);
      return {
        id,
        name,
        isFolder,
        type: inferFileType(name, isFolder),
        sizeBytes,
        updatedAt: null,
        extension: inferExtension(name),
      };
    });
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = await this.client.createFolder({ name: input.name, parentId: input.parentId });
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    await this.client.renameFile({ fileId: input.itemId, newName: input.newName });
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    const fileIds = items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.deleteItems({ fileIds });
    }
    return { deletedCount: fileIds.length };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.moveItems({ fileIds, targetDirectoryId: input.targetDirectoryId });
    }
    return { movedCount: fileIds.length };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.copyItems({ fileIds, targetDirectoryId: input.targetDirectoryId });
    }
    return { copiedCount: fileIds.length };
  }
}

export class Pan123FileManagerAdapter implements DriveFileManager {
  private readonly client: Pan123Client;
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    const token = typeof opts.credential === "object" && opts.credential !== null && "token" in opts.credential
      ? String((opts.credential as { token: unknown }).token)
      : "";
    this.client = new Pan123Client({ token });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "0";
    const raw = await this.client.listFiles(targetDir);
    const items: DriveFileItem[] = raw.map((r) => ({
      id: r.id,
      name: r.name,
      isFolder: Boolean(r.isFolder),
      type: inferFileType(r.name, Boolean(r.isFolder)),
      sizeBytes: r.size || 0,
      updatedAt: null,
      extension: inferExtension(r.name),
    }));
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = await this.client.createFolder({ name: input.name, parentId: input.parentId });
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    await this.client.renameFile({ fileId: input.itemId, name: input.newName });
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    const entries = items.map((i) => (i.name ? { id: i.id, isFolder: i.isFolder, name: i.name } : { id: i.id, isFolder: i.isFolder }));
    if (entries.length > 0) {
      await this.client.trash(entries);
    }
    return { deletedCount: entries.length };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.moveFiles({ fileIds, targetParentId: input.targetDirectoryId });
    }
    return { movedCount: fileIds.length };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.copyFiles({ fileIds, targetParentId: input.targetDirectoryId });
    }
    return { copiedCount: fileIds.length };
  }
}

export class TianyiFileManagerAdapter implements DriveFileManager {
  private readonly client: TianyiClient;
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    const cred = (opts.credential ?? {}) as { sessionKey?: string; accessToken?: string; refreshToken?: string };
    this.client = new TianyiClient({
      sessionKey: cred.sessionKey ?? "",
      accessToken: cred.accessToken ?? "",
      refreshToken: cred.refreshToken ?? "",
    });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "-11";
    const raw = await this.client.listFiles(targetDir);
    const items: DriveFileItem[] = raw.map((r) => ({
      id: r.id,
      name: r.name,
      isFolder: Boolean(r.isFolder),
      type: inferFileType(r.name, Boolean(r.isFolder)),
      sizeBytes: r.size || 0,
      updatedAt: null,
      extension: inferExtension(r.name),
    }));
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = await this.client.createFolder({ name: input.name, parentId: input.parentId });
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    await this.client.renameFile({ fileId: input.itemId, name: input.newName });
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    const entries = items.map((i) => (i.name ? { id: i.id, isFolder: i.isFolder, name: i.name } : { id: i.id, isFolder: i.isFolder }));
    if (entries.length > 0) {
      await this.client.batchDelete(entries);
    }
    return { deletedCount: entries.length };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    const entries = input.items.map((i) => ({ id: i.id, isFolder: i.isFolder }));
    if (entries.length > 0) {
      await this.client.moveFiles({ entries, targetFolderId: input.targetDirectoryId });
    }
    return { movedCount: entries.length };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    const entries = input.items.map((i) => ({ id: i.id, isFolder: i.isFolder }));
    if (entries.length > 0) {
      await this.client.copyFiles({ entries, targetFolderId: input.targetDirectoryId });
    }
    return { copiedCount: entries.length };
  }
}

export class GuangYaFileManagerAdapter implements DriveFileManager {
  private readonly client: GuangYaClient;
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    const cred = (opts.credential ?? {}) as { accessToken?: string; refreshToken?: string; deviceId?: string };
    this.client = new GuangYaClient({
      accessToken: cred.accessToken ?? "",
      refreshToken: cred.refreshToken ?? "",
      deviceId: cred.deviceId ?? "",
    });
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "0";
    const raw = await this.client.listFiles(targetDir);
    const items: DriveFileItem[] = raw.map((r) => {
      const isFolder = r.resType === 1;
      return {
        id: r.fileId,
        name: r.fileName,
        isFolder,
        type: inferFileType(r.fileName, isFolder),
        sizeBytes: r.fileSize || 0,
        updatedAt: null,
        extension: inferExtension(r.fileName),
      };
    });
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = await this.client.createDir(input.parentId, input.name);
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    await this.client.renameFile(input.itemId, input.newName);
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    const fileIds = items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.deleteFiles(fileIds);
    }
    return { deletedCount: fileIds.length };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.moveFiles(fileIds, input.targetDirectoryId);
    }
    return { movedCount: fileIds.length };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    const fileIds = input.items.map((i) => i.id).filter(Boolean);
    if (fileIds.length > 0) {
      await this.client.copyFiles(fileIds, input.targetDirectoryId);
    }
    return { copiedCount: fileIds.length };
  }
}

export interface FakeItemRecord {
  id: string;
  parentId: string;
  name: string;
  isFolder: boolean;
  sizeBytes: number;
}

export class FakeFileManagerAdapter implements DriveFileManager {
  private readonly opts: DriveFileManagerOptions;
  private readonly records: Map<string, FakeItemRecord> = new Map();
  private nextId = 1000;

  constructor(opts: DriveFileManagerOptions, initialRecords?: FakeItemRecord[]) {
    this.opts = opts;
    const rootId = opts.rootCid || "0";
    this.records.set(rootId, { id: rootId, parentId: "", name: "根目录", isFolder: true, sizeBytes: 0 });
    if (opts.moviesCid) {
      this.records.set(opts.moviesCid, { id: opts.moviesCid, parentId: rootId, name: "Movies", isFolder: true, sizeBytes: 0 });
    }
    if (opts.tvCid) {
      this.records.set(opts.tvCid, { id: opts.tvCid, parentId: rootId, name: "TV", isFolder: true, sizeBytes: 0 });
    }
    if (opts.animeCid) {
      this.records.set(opts.animeCid, { id: opts.animeCid, parentId: rootId, name: "Anime", isFolder: true, sizeBytes: 0 });
    }
    if (initialRecords) {
      for (const rec of initialRecords) {
        this.records.set(rec.id, rec);
      }
    }
  }

  async listDirectory(directoryId?: string): Promise<DriveDirectoryListing> {
    const targetDir = directoryId || this.opts.rootCid || "0";
    const items: DriveFileItem[] = [];
    for (const rec of this.records.values()) {
      if (rec.parentId === targetDir) {
        items.push({
          id: rec.id,
          name: rec.name,
          isFolder: rec.isFolder,
          type: inferFileType(rec.name, rec.isFolder),
          sizeBytes: rec.sizeBytes,
          updatedAt: null,
          extension: inferExtension(rec.name),
        });
      }
    }
    return buildListing(this.opts, targetDir, items);
  }

  async createFolder(input: { parentId: string; name: string }): Promise<{ id: string; name: string }> {
    const id = `folder_${this.nextId++}`;
    this.records.set(id, { id, parentId: input.parentId, name: input.name, isFolder: true, sizeBytes: 0 });
    return { id, name: input.name };
  }

  async renameItem(input: { itemId: string; newName: string; isFolder: boolean }): Promise<void> {
    const item = this.records.get(input.itemId);
    if (item) {
      item.name = input.newName;
    }
  }

  async deleteItems(items: Array<{ id: string; isFolder: boolean; name?: string }>): Promise<{ deletedCount: number }> {
    let deleted = 0;
    for (const it of items) {
      if (this.records.delete(it.id)) {
        deleted += 1;
      }
    }
    return { deletedCount: deleted };
  }

  async moveItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ movedCount: number }> {
    let moved = 0;
    for (const it of input.items) {
      const rec = this.records.get(it.id);
      if (rec) {
        rec.parentId = input.targetDirectoryId;
        moved += 1;
      }
    }
    return { movedCount: moved };
  }

  async copyItems(input: { items: Array<{ id: string; isFolder: boolean }>; targetDirectoryId: string }): Promise<{ copiedCount: number }> {
    let copied = 0;
    for (const it of input.items) {
      const orig = this.records.get(it.id);
      if (orig) {
        const newId = `copy_${this.nextId++}`;
        this.records.set(newId, {
          id: newId,
          parentId: input.targetDirectoryId,
          name: `${orig.name}_副本`,
          isFolder: orig.isFolder,
          sizeBytes: orig.sizeBytes,
        });
        copied += 1;
      }
    }
    return { copiedCount: copied };
  }
}

export function createDriveFileManager(opts: DriveFileManagerOptions): DriveFileManager {
  if (process.env.MEDIA_TRACK_STORAGE_ADAPTER === "fake") {
    return new FakeFileManagerAdapter(opts);
  }

  switch (opts.provider) {
    case "quark":
      return new QuarkFileManagerAdapter(opts);
    case "pan115":
      return new Pan115FileManagerAdapter(opts);
    case "pan123":
      return new Pan123FileManagerAdapter(opts);
    case "tianyi":
      return new TianyiFileManagerAdapter(opts);
    case "guangya":
      return new GuangYaFileManagerAdapter(opts);
    default:
      return new FakeFileManagerAdapter(opts);
  }
}
