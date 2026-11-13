import type { StorageExecutor } from "../domain/ports.js";
import type { PackageTreeFile } from "../domain/domain.js";
import { isJunkFile, isVideoFile } from "./version-ranker.js";

/**
 * 缺扩展名的「疑似正片」识别。
 *
 * 背景：115 转存经常把文件名截断在发布组后缀上（如
 * `...1080p.WEB-DL.H264.AAC-ColorTV`），扩展名整段丢失。这类文件
 * `isVideoFile()` 认不出，于是既不会被整理、也不会被统计——此前甚至被
 * 清理逻辑误删过。
 *
 * 这里的策略是「只报告、不猜测」：先按体积把疑似正片挑出来给用户看，
 * 补后缀时再读文件头（magic bytes）确认容器格式，避免瞎猜 mp4/mkv。
 */

/** 正片量级下限：低于此值的大概率是字幕、封面、nfo 等附属文件。 */
export const DEFAULT_MIN_UNRECOGNIZED_BYTES = 100 * 1024 * 1024;

export interface UnrecognizedMediaItem {
  fileId: string;
  fileName: string;
  /** 文件所在目录（Season 目录或剧集根目录）。 */
  directoryId: string;
  directoryName: string;
  sizeBytes: number;
}

export type SniffedContainer = "mp4" | "mkv" | "avi" | "flv" | "ts" | "unknown";

/**
 * 是否「看起来像视频但没有可识别扩展名」。
 *
 * 判定依据只有两条：**没有已知视频/垃圾扩展名** + **体积达到正片量级**。
 * 故意不依赖文件名里的关键词——发布组命名千奇百怪，关键词只会带来误判。
 */
export function looksLikeVideoWithoutExtension(
  fileName: string,
  sizeBytes: number | undefined,
  minSizeBytes: number = DEFAULT_MIN_UNRECOGNIZED_BYTES,
): boolean {
  const name = fileName.trim();
  if (name.length === 0) return false;
  if (isVideoFile(name)) return false;
  if (isJunkFile(name)) return false;
  const size = sizeBytes ?? 0;
  return size >= minSizeBytes;
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** MP4 / MOV：第 4–8 字节为 `ftyp`。 */
function isIsoBmff(head: Uint8Array): boolean {
  return head.length >= 12 && asciiAt(head, 4, "ftyp");
}

/** Matroska / WebM：EBML 魔数 1A 45 DF A3。 */
function isEbml(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/** AVI：`RIFF....AVI `。 */
function isRiffAvi(head: Uint8Array): boolean {
  return head.length >= 12 && asciiAt(head, 0, "RIFF") && asciiAt(head, 8, "AVI ");
}

function isFlv(head: Uint8Array): boolean {
  return head.length >= 3 && asciiAt(head, 0, "FLV");
}

/** MPEG-TS：包长 188，首尾同步字节均为 0x47。 */
function isMpegTs(head: Uint8Array): boolean {
  if (head.length < 1 || head[0] !== 0x47) return false;
  return head.length < 189 || head[188] === 0x47;
}

/**
 * 容器判定表。用表驱动而非 if 链：新增格式只需加一行，
 * 也避免主判定函数被 ESLint 复杂度预算拦下。
 */
const CONTAINER_MATCHERS: ReadonlyArray<{ container: SniffedContainer; test: (head: Uint8Array) => boolean }> = [
  { container: "mp4", test: isIsoBmff },
  { container: "mkv", test: isEbml },
  { container: "avi", test: isRiffAvi },
  { container: "flv", test: isFlv },
  { container: "ts", test: isMpegTs },
];

/** 由文件头前若干字节判定容器格式；无法判定时返回 `unknown`（调用方不得猜测）。 */
export function sniffVideoContainer(head: Uint8Array): SniffedContainer {
  const matched = CONTAINER_MATCHERS.find((matcher) => matcher.test(head));
  return matched ? matched.container : "unknown";
}

/** 容器 → 扩展名；unknown 返回 null（不猜）。 */
export function extensionForContainer(container: SniffedContainer): string | null {
  switch (container) {
    case "mp4":
      return "mp4";
    case "mkv":
      return "mkv";
    case "avi":
      return "avi";
    case "flv":
      return "flv";
    case "ts":
      return "ts";
    default:
      return null;
  }
}

/** 目标文件名：仅在原文件名确实缺扩展名时追加，避免重复拼接。 */
export function buildRenamedFileName(fileName: string, extension: string): string {
  const trimmed = fileName.trim();
  const suffix = `.${extension.replace(/^\./, "")}`;
  return trimmed.toLowerCase().endsWith(suffix.toLowerCase()) ? trimmed : `${trimmed}${suffix}`;
}

function fileNameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** 从一棵目录树里挑出缺扩展名的疑似正片（只看该目录直属文件）。 */
export function collectUnrecognizedFromTree(
  tree: readonly PackageTreeFile[],
  directory: { id: string; name: string },
  minSizeBytes: number = DEFAULT_MIN_UNRECOGNIZED_BYTES,
): UnrecognizedMediaItem[] {
  return tree
    .filter((file) => !file.path.includes("/"))
    .map((file) => ({ file, name: fileNameOf(file.path) }))
    .filter(({ file, name }) => looksLikeVideoWithoutExtension(name, file.sizeBytes, minSizeBytes))
    .map(({ file, name }) => ({
      fileId: file.providerFileId,
      fileName: name,
      directoryId: directory.id,
      directoryName: directory.name,
      sizeBytes: file.sizeBytes,
    }));
}

/**
 * 扫描一个剧集目录：剧集根目录 + 各 Season 目录 + 各 staging 目录。
 *
 * 只做只读列举，不产生任何副作用；单个目录列举失败不影响其它目录。
 */
export async function scanUnrecognizedMedia(input: {
  storage: Pick<StorageExecutor, "listChildDirectories" | "listTree">;
  showDirectoryId: string;
  minSizeBytes?: number | undefined;
}): Promise<UnrecognizedMediaItem[]> {
  const minSizeBytes = input.minSizeBytes ?? DEFAULT_MIN_UNRECOGNIZED_BYTES;
  const showDir = { id: input.showDirectoryId, name: "" };

  const items: UnrecognizedMediaItem[] = [];
  try {
    const rootTree = await input.storage.listTree({ directoryId: input.showDirectoryId });
    items.push(...collectUnrecognizedFromTree(rootTree, showDir, minSizeBytes));
  } catch {
    // 根目录列举失败时继续扫子目录
  }

  let children: Array<{ id: string; name: string }> = [];
  try {
    children = await input.storage.listChildDirectories(input.showDirectoryId);
  } catch {
    return items;
  }

  const targets = children.filter(
    (dir) => /^Season\s+\d+$/i.test(dir.name.trim()) || dir.name.trim().toLowerCase().startsWith("staging-"),
  );

  for (const dir of targets) {
    try {
      const tree = await input.storage.listTree({ directoryId: dir.id });
      items.push(...collectUnrecognizedFromTree(tree, dir, minSizeBytes));
    } catch {
      // 单个目录失败不影响整体结果
    }
  }

  return items;
}
