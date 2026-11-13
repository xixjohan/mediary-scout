import type { VerifiedFile } from "../domain/domain.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";
import { isExtensionlessVideoName, planExtensionFixes } from "../execution/extensionless-video.js";

/**
 * 转存落盘文件的识别与扩展名归一。
 *
 * 从 `storage-115-executor.ts` 抽出来是因为该文件已在行数棘轮基线上（只降不升），
 * 而这段逻辑与 115 的调用编排无关——它只依赖「列举目录」与「改名」两个动作，
 * 因此用回调注入，也便于单测。
 *
 * 要解决的具体问题：115 转存会把文件名截断在发布组后缀上
 * （`...1080p.WEB-DL.H264.AAC-ColorTV`），扩展名整段丢失。这类文件
 * 按扩展名过滤时不可见，于是 transfer 判定"没落地" → 换候选 → 文件留在
 * staging 变成泄漏，同时整理器也永远认不出它。
 */

/** 只描述用得到的字段，避免与 115 客户端的类型互相依赖。 */
export interface RawListingItem {
  id?: string | number | undefined;
  fid?: string | number | undefined;
  file_id?: string | number | undefined;
  cid?: string | number | undefined;
  name?: string | undefined;
  n?: string | undefined;
  size?: string | number | undefined;
  s?: string | number | undefined;
  fc?: string | number | undefined;
  isDirectory?: boolean | undefined;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isFolder(item: RawListingItem): boolean {
  if (item.isDirectory !== undefined) return item.isDirectory;
  if (Boolean(item.fid ?? item.file_id)) return false;
  if (item.fc === "0" || item.fc === 0) return true;
  return item.cid !== undefined;
}

function fileIdOf(item: RawListingItem): string {
  return toText(item.fid ?? item.file_id ?? item.id);
}

function nameOf(item: RawListingItem): string {
  return toText(item.name ?? item.n);
}

const MAX_DEPTH = 3;

/**
 * 递归列举目录，返回「视频 + 无扩展名但体积像正片」的文件。
 *
 * 与 `listVideoFiles` 的唯一差别就是纳入后者——transfer 的 before/after 必须用
 * 同一口径，否则截断文件会被误判成"没落地"。
 */
export async function collectLandedVideos(input: {
  listItems: (directoryId: string) => Promise<RawListingItem[]>;
  videoExtensions: ReadonlySet<string>;
  rootDirectoryId: string;
  currentDirectoryId?: string | undefined;
  depth?: number | undefined;
}): Promise<VerifiedFile[]> {
  const depth = input.depth ?? 1;
  if (depth > MAX_DEPTH) return [];
  const currentDirectoryId = input.currentDirectoryId ?? input.rootDirectoryId;
  const items = await input.listItems(currentDirectoryId);

  const files: VerifiedFile[] = [];
  for (const item of items) {
    if (isFolder(item)) {
      const childId = toText(item.cid ?? item.id);
      if (childId) {
        files.push(
          ...(await collectLandedVideos({ ...input, currentDirectoryId: childId, depth: depth + 1 })),
        );
      }
      continue;
    }
    const file = verifiedLandedFile(item, input.rootDirectoryId, input.videoExtensions);
    if (file) files.push(file);
  }
  return files;
}

function verifiedLandedFile(
  item: RawListingItem,
  storageDirectoryId: string,
  videoExtensions: ReadonlySet<string>,
): VerifiedFile | null {
  const name = nameOf(item);
  const sizeBytes = toNumber(item.size ?? item.s);
  const lower = name.toLowerCase();
  const byExtension = Array.from(videoExtensions).some((extension) => lower.endsWith(extension));
  if (!byExtension && !isExtensionlessVideoName(name, sizeBytes)) return null;

  const providerFileId = fileIdOf(item);
  if (!providerFileId) return null;
  return {
    id: providerFileId,
    storageDirectoryId,
    name,
    sizeBytes,
    episodeCode: episodeCodeFromFileName(name),
    providerFileId,
  };
}

/**
 * 落盘后补扩展名。
 *
 * 扩展名只来自「资源名自带视频后缀」，拿不到就不动——绝不默认 mp4。
 * 失败只记日志：转存本身已经成功，下游「一键补后缀」还能读文件头修复。
 */
export async function normalizeLandedExtensions(input: {
  landed: readonly VerifiedFile[];
  sourceTitle: string | undefined;
  rename: (fileId: string, newName: string) => Promise<{ ok: boolean; message: string }>;
  warn?: ((message: string, error?: unknown) => void) | undefined;
}): Promise<number> {
  const fixes = planExtensionFixes({
    files: input.landed.map((file) => ({ id: file.id, name: file.name, sizeBytes: file.sizeBytes })),
    sourceNames: [input.sourceTitle],
  });
  let renamed = 0;
  for (const fix of fixes) {
    try {
      const result = await input.rename(fix.fileId, fix.to);
      if (result.ok) {
        renamed += 1;
      } else {
        input.warn?.(`补扩展名被上游拒绝: ${fix.from} -> ${fix.to} (${result.message})`);
      }
    } catch (error) {
      input.warn?.(`补扩展名失败: ${fix.from} -> ${fix.to}`, error);
    }
  }
  return renamed;
}
