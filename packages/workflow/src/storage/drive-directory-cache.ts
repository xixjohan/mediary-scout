import type {
  DriveBreadcrumb,
  DriveDirectoryListing,
  DriveFileItem,
  DriveFileManagerOptions,
} from "./drive-file-manager-types.js";

export interface DirectoryNode {
  name: string;
  parentId?: string;
}

export class DriveDirectoryCache {
  private readonly nodes = new Map<string, DirectoryNode>();
  private readonly opts: DriveFileManagerOptions;

  constructor(opts: DriveFileManagerOptions) {
    this.opts = opts;
    const rootId = opts.rootCid || "0";
    this.nodes.set(rootId, { name: "根目录" });
    if (opts.moviesCid) this.nodes.set(opts.moviesCid, { name: "电影", parentId: rootId });
    if (opts.tvCid) this.nodes.set(opts.tvCid, { name: "剧集", parentId: rootId });
    if (opts.animeCid) this.nodes.set(opts.animeCid, { name: "动漫", parentId: rootId });
  }

  recordChildren(parentId: string, items: DriveFileItem[]): void {
    for (const item of items) {
      if (item.isFolder && item.id) {
        const existing = this.nodes.get(item.id);
        if (!existing || existing.name !== item.name) {
          this.nodes.set(item.id, { name: item.name, parentId });
        }
      }
    }
  }

  setNode(id: string, node: DirectoryNode): void {
    this.nodes.set(id, node);
  }

  getNode(id: string): DirectoryNode | undefined {
    return this.nodes.get(id);
  }

  resolveCurrentName(dirId: string, realName?: string): string {
    if (this.opts.moviesCid && dirId === this.opts.moviesCid) return "电影";
    if (this.opts.tvCid && dirId === this.opts.tvCid) return "剧集";
    if (this.opts.animeCid && dirId === this.opts.animeCid) return "动漫";
    const rootId = this.opts.rootCid || "0";
    if (!dirId || dirId === "0" || dirId === rootId) return "根目录";
    if (realName) return realName;
    const cached = this.nodes.get(dirId);
    if (cached?.name) return cached.name;
    return "目录";
  }

  buildBreadcrumbs(targetDir: string, realName?: string): DriveBreadcrumb[] {
    const rootId = this.opts.rootCid || "0";
    if (!targetDir || targetDir === "0" || targetDir === rootId) {
      return [{ id: rootId, name: "根目录" }];
    }

    const breadcrumbs: DriveBreadcrumb[] = [];
    let curr: string | undefined = targetDir;
    const visited = new Set<string>();

    while (curr && !visited.has(curr)) {
      visited.add(curr);
      const node = this.nodes.get(curr);
      const name = curr === targetDir && realName ? realName : node?.name;
      if (name) {
        breadcrumbs.unshift({ id: curr, name });
        curr = node?.parentId;
      } else {
        break;
      }
    }

    if (!breadcrumbs.some((b) => b.id === rootId)) {
      breadcrumbs.unshift({ id: rootId, name: "根目录" });
    }

    if (!breadcrumbs.some((b) => b.id === targetDir)) {
      breadcrumbs.push({ id: targetDir, name: realName || "目录" });
    }

    return breadcrumbs;
  }
}

export function resolveCurrentDirectoryName(
  dirId: string,
  opts: {
    rootCid?: string | null;
    moviesCid?: string | null;
    tvCid?: string | null;
    animeCid?: string | null;
  },
  realDirName?: string,
): string {
  if (opts.moviesCid && dirId === opts.moviesCid) return "电影";
  if (opts.tvCid && dirId === opts.tvCid) return "剧集";
  if (opts.animeCid && dirId === opts.animeCid) return "动漫";
  const rootId = opts.rootCid || "0";
  if (!dirId || dirId === "0" || dirId === rootId) return "根目录";
  if (realDirName) return realDirName;
  return "目录";
}

export function summarizeItems(items: DriveFileItem[]): {
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

export function sortDriveItems(items: DriveFileItem[]): DriveFileItem[] {
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
  });
}

export function buildListing(
  opts: DriveFileManagerOptions,
  dirId: string,
  rawItems: DriveFileItem[],
  customBreadcrumbs?: DriveBreadcrumb[],
  realDirName?: string,
): DriveDirectoryListing {
  const items = sortDriveItems(rawItems);
  const summary = summarizeItems(items);
  const dirName = resolveCurrentDirectoryName(dirId, opts, realDirName);

  let breadcrumbs: DriveBreadcrumb[];
  if (customBreadcrumbs && customBreadcrumbs.length > 0) {
    breadcrumbs = [...customBreadcrumbs];
    const rootId = opts.rootCid || "0";
    if (breadcrumbs[0] && (breadcrumbs[0].id === rootId || breadcrumbs[0].id === "0")) {
      breadcrumbs[0].name = "根目录";
    }
  } else {
    const rootId = opts.rootCid || "0";
    breadcrumbs = [{ id: rootId, name: "根目录" }];
    if (dirId !== rootId) {
      breadcrumbs.push({ id: dirId, name: dirName });
    }
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
