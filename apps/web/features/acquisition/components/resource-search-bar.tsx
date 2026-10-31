"use client";

import { Search, X } from "lucide-react";

export function appendKeywordChip(current: string, chip: string): string {
  const trimmed = current.trim();
  const token = chip.trim();
  if (!token) return current;
  if (!trimmed) return token;
  const tokens = trimmed.split(/\s+/);
  if (tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
    return trimmed;
  }
  return `${trimmed} ${token}`;
}

export const MODIFIER_CHIPS = ["4K", "1080p", "简日内嵌", "原盘"] as const;

export interface QuickChipsProps {
  customKeyword: string;
  setCustomKeyword: (v: string) => void;
  title?: string | undefined;
  year?: number | undefined;
}

export function ResourceQuickChips({
  customKeyword,
  setCustomKeyword,
  title,
  year,
}: QuickChipsProps) {
  const cleanTitle = title?.trim();

  return (
    <div className="title-resources-quick-chips">
      <span className="title-resources-quick-label">快捷词：</span>
      {cleanTitle ? (
        <button
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(cleanTitle)}
          title="以原片名检索"
        >
          {cleanTitle}
        </button>
      ) : null}
      {cleanTitle && year && Number.isInteger(year) ? (
        <button
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(`${cleanTitle} ${year}`)}
          title="以片名+年份检索"
        >
          {cleanTitle} {year}
        </button>
      ) : null}
      {MODIFIER_CHIPS.map((mod) => (
        <button
          key={mod}
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(appendKeywordChip(customKeyword, mod))}
          title={`追加 ${mod} 过滤词`}
        >
          + {mod}
        </button>
      ))}
    </div>
  );
}

export interface ResourceSearchBarProps {
  customKeyword: string;
  setCustomKeyword: (v: string) => void;
  selectedSeason: number | undefined;
  setSelectedSeason: (v: number | undefined) => void;
  selectedEpisode: string;
  setSelectedEpisode: (v: string) => void;
  mediaType?: "movie" | "tv" | "anime" | undefined;
  seasonNumbers?: readonly number[] | undefined;
  title?: string | undefined;
  year?: number | undefined;
  busy: boolean;
  throttled: boolean;
  retryAfterMs?: number | undefined;
  onSearch: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function ResourceSearchBar({
  customKeyword,
  setCustomKeyword,
  selectedSeason,
  setSelectedSeason,
  selectedEpisode,
  setSelectedEpisode,
  mediaType,
  seasonNumbers,
  title,
  year,
  busy,
  throttled,
  retryAfterMs,
  onSearch,
  onKeyDown,
}: ResourceSearchBarProps) {
  return (
    <div className="title-resources-search-bar">
      <div className="title-resources-input-wrap">
        <Search size={14} aria-hidden />
        <input
          type="text"
          value={customKeyword}
          onChange={(e) => setCustomKeyword(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="自定义搜索关键词（如：4K 喵萌奶茶屋 S01...）"
          aria-label="自定义搜索关键词"
        />
        {customKeyword.trim() ? (
          <button
            type="button"
            className="title-resources-input-clear"
            aria-label="清空关键词"
            onClick={() => setCustomKeyword("")}
          >
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>

      {mediaType !== "movie" && seasonNumbers && seasonNumbers.length > 1 ? (
        <select
          className="title-resources-select"
          value={selectedSeason ?? ""}
          onChange={(e) => setSelectedSeason(e.target.value ? Number(e.target.value) : undefined)}
          aria-label="选择季度"
        >
          <option value="">全部季</option>
          {seasonNumbers.map((num) => (
            <option key={num} value={num}>
              第 {num} 季
            </option>
          ))}
        </select>
      ) : null}

      {mediaType !== "movie" ? (
        <input
          type="number"
          min="1"
          className="title-resources-number-input"
          value={selectedEpisode}
          onChange={(e) => setSelectedEpisode(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="集数(选填)"
          aria-label="指定集数"
        />
      ) : null}

      <button
        type="button"
        className="title-resources-search"
        onClick={onSearch}
        disabled={busy || throttled}
      >
        {busy ? "查询中…" : throttled ? `请稍候 ${Math.ceil((retryAfterMs ?? 0) / 1000)}s` : "查询资源"}
      </button>

      <ResourceQuickChips
        customKeyword={customKeyword}
        setCustomKeyword={setCustomKeyword}
        title={title}
        year={year}
      />
    </div>
  );
}
