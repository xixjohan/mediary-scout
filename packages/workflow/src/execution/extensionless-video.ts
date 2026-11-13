import { isVideoFile } from "./version-ranker.js";
import { looksLikeVideoWithoutExtension, DEFAULT_MIN_UNRECOGNIZED_BYTES } from "./unrecognized-media.js";

/**
 * 转存落盘时的扩展名归一。
 *
 * 背景：115 转存会把文件名截断在发布组后缀上（`...1080p.WEB-DL.H264.AAC-ColorTV`），
 * 扩展名整段丢失。这类文件在下游有三个后果：
 *   1. `listVideoFiles()` 按扩展名过滤 → 看不见，transfer 判定为"没落地"，
 *      工作流换候选，文件留在 staging 变成泄漏；
 *   2. 整理器认不出 → 永远不会被归档到 Season 目录；
 *   3. 播放器/Plex 拿不到容器信息。
 *
 * 这里的策略是**不猜**：扩展名只能来自「资源名里显式带的视频后缀」。
 * 拿不到就原样保留，交给下游「一键补后缀」（读文件头 magic bytes 判定）。
 */

/** 落盘文件是否「像视频但没有视频扩展名」。复用同一套阈值，避免两处漂移。 */
export function isExtensionlessVideoName(
  name: string,
  sizeBytes: number | undefined,
  minBytes: number = DEFAULT_MIN_UNRECOGNIZED_BYTES,
): boolean {
  return looksLikeVideoWithoutExtension(name, sizeBytes, minBytes);
}

/**
 * 从任意名字（分享名 / 种子名 / 文件名）里取视频扩展名。
 *
 * 只认「最后一段是 2–5 位字母数字且属于已知视频后缀」，因此
 * `...H264.AAC-ColorTV` 这种带连字符的发布组后缀不会被误当成扩展名。
 */
export function videoExtensionFromName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(trimmed);
  if (!match?.[1]) return null;
  const extension = match[1].toLowerCase();
  return isVideoFile(`probe.${extension}`) ? extension : null;
}

export interface ExtensionFix {
  fileId: string;
  from: string;
  to: string;
  extension: string;
}

/**
 * 为一批落盘文件规划「补扩展名」。
 *
 * - 扩展名来源：`sourceNames`（资源名/种子名）里第一个能取到的视频后缀；
 * - 取不到 → 不规划（绝不默认 mp4）；
 * - 已经带视频扩展名的 → 跳过。
 */
export function planExtensionFixes(input: {
  files: ReadonlyArray<{ id: string; name: string; sizeBytes?: number | undefined }>;
  sourceNames?: ReadonlyArray<string | null | undefined> | undefined;
  minBytes?: number | undefined;
}): ExtensionFix[] {
  const minBytes = input.minBytes ?? DEFAULT_MIN_UNRECOGNIZED_BYTES;
  const extension = (input.sourceNames ?? [])
    .map((name) => videoExtensionFromName(name))
    .find((value): value is string => value !== null);
  if (!extension) return [];

  const fixes: ExtensionFix[] = [];
  for (const file of input.files) {
    if (!isExtensionlessVideoName(file.name, file.sizeBytes, minBytes)) continue;
    fixes.push({
      fileId: file.id,
      from: file.name,
      to: `${file.name.trim()}.${extension}`,
      extension,
    });
  }
  return fixes;
}
