import type { MediaOrganizer, TrackedSeasonState } from "@media-track/workflow";

/** 把「归档重复版本 / 清理临时目录」拼成可选后缀，供整理结果文案复用。 */
export function buildCleanupSuffix(archived: number, removed: number): string {
  const parts: string[] = [];
  if (archived > 0) parts.push(`归档重复版本 ${archived} 个`);
  if (removed > 0) parts.push(`清理临时目录 ${removed} 个`);
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}

/**
 * 整理季目录内的重复版本 + 清理残留 staging 空壳。
 *
 * 背景：多次转存/多次整理会让同一集在 Season 目录里留下
 * `S01E01.mp4` / `S01E01(1).mp4` 并存；而 staging-* 空壳在整理失败后无人回收。
 * 之前的去重只发生在 staging 内部，已落地的季目录从不复查。
 */
export async function dedupeAndCleanupShow(input: {
  organizer: MediaOrganizer;
  title: TrackedSeasonState["title"];
  showDirectoryId: string;
  fallbackCategoryParentId?: string | undefined;
}): Promise<{ archived: number; removed: number; suffix: string }> {
  const dedupe = await input.organizer.dedupeSeasonDirectories({
    showDirectoryId: input.showDirectoryId,
    title: input.title.title,
    type: input.title.type === "anime" ? "anime" : "tv",
    year: input.title.year,
    tmdbId: input.title.tmdbId,
    fallbackCategoryParentId: input.fallbackCategoryParentId,
  });
  const cleanup = await input.organizer.cleanupStagingDirectories({
    showDirectoryId: input.showDirectoryId,
  });
  return {
    archived: dedupe.archivedCount,
    removed: cleanup.removed.length,
    suffix: buildCleanupSuffix(dedupe.archivedCount, cleanup.removed.length),
  };
}
