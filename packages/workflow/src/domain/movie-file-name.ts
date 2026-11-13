import { cleanMediaTitle, extractReleaseTags } from "./episode-code.js";

/**
 * 电影文件名规范（与 Jellyfin / Plex / Radarr 的通行做法对齐）。
 *
 * 背景：`MediaOrganizer.organizeMovieDirectory()` 原先只把主版本从包装目录里搬出来，
 * **从不重命名电影文件**——于是库里看到的仍是
 * `The.Hotel.New.Hampshire.1984.1080p.BluRay.x265-RARBG.mp4`。
 * 剧集侧早已有 `canonicalEpisodeFileName()`，电影侧缺同等的规范入口。
 *
 * 规则：
 * - 基础形态：`Title (Year).ext`
 * - 保留发布信息：`Title (Year) [1080p] [BluRay].ext`（标签来自源文件名方括号）
 * - 年份缺失时省略括号，避免产生 `Title ().ext`
 */

export interface MovieFileNameInput {
  title: string;
  year?: number | string | null | undefined;
  sourceName: string;
  /** 是否保留源文件名里的发布标签（画质/来源/发布组）。 */
  preserveMetadata?: boolean | undefined;
}

function normalizeYear(year: number | string | null | undefined): string | null {
  if (year === null || year === undefined) return null;
  const text = String(year).trim();
  if (!text || text === "0") return null;
  return text;
}

/** 去掉文件名里不允许的字符，避免不同网盘之间的兼容性问题。 */
export function sanitizeFileSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalMovieFileName(input: MovieFileNameInput): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  const title = sanitizeFileSegment(cleanMediaTitle(input.title));
  const year = normalizeYear(input.year);
  const base = year ? `${title} (${year})` : title;

  if (!input.preserveMetadata) return `${base}${extension}`;

  const tags = extractReleaseTags(input.sourceName)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
  return `${base}${suffix}${extension}`;
}

/** 判断某个名字是否已经是规范形态（避免重复 rename 触发网盘限流）。 */
export function isCanonicalMovieFileName(fileName: string, title: string, year?: number | string | null): boolean {
  return fileName === canonicalMovieFileName({ title, year, sourceName: fileName });
}
