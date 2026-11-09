"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { TitleHubSeason } from "../../../lib/title-hub";
import {
  extractMissingEpisodes,
  isSeasonEpisodeStateIncomplete,
  filterMissingBySeason,
  paginateMissingEpisodes,
  type MissingEpisodeItem,
} from "../contracts/missing-episodes-model";
import { useEpisodeTarget } from "./episode-target-context";

const PAGE_SIZE = 12;

export interface MissingEpisodesDeckProps {
  seasons: readonly TitleHubSeason[];
  title?: string | undefined;
}

export function MissingEpisodesDeck({ seasons }: MissingEpisodesDeckProps) {
  const { target, targetAndScroll } = useEpisodeTarget();
  const [seasonFilter, setSeasonFilter] = useState<number | "all">("all");
  const [page, setPage] = useState<number>(1);

  // 提取所有已开播但缺失的集数
  const allMissing = useMemo(() => extractMissingEpisodes(seasons), [seasons]);

  // 统计各季缺失集数，用于季别切换药丸
  const seasonCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of allMissing) {
      map.set(item.seasonNumber, (map.get(item.seasonNumber) ?? 0) + 1);
    }
    return map;
  }, [allMissing]);

  const hasTrackedSeason = useMemo(
    () => seasons.some((season) => season.tracked),
    [seasons],
  );
  const needsSync = seasons.some(isSeasonEpisodeStateIncomplete);

  // 根据当前季筛选器过滤
  const filteredItems = useMemo(
    () => filterMissingBySeason(allMissing, seasonFilter),
    [allMissing, seasonFilter],
  );

  // 分页切片计算
  const paginated = useMemo(
    () => paginateMissingEpisodes(filteredItems, page, PAGE_SIZE),
    [filteredItems, page],
  );

  // 季切换回调：重置页码为第 1 页
  const handleSeasonChange = (filter: number | "all") => {
    setSeasonFilter(filter);
    setPage(1);
  };

  // 点击“搜此集”
  const handleTarget = (item: MissingEpisodeItem) => {
    targetAndScroll({
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      episodeCode: item.episodeCode,
    });
  };

  if (!hasTrackedSeason) {
    return null;
  }

  if (allMissing.length === 0) {
    return (
      <div className="missing-episodes-deck is-complete">
        <div className="missing-deck-complete-wrap">
          {needsSync
            ? <AlertCircle size={16} className="missing-deck-alert-icon" aria-hidden />
            : <CheckCircle2 size={16} className="missing-deck-complete-icon" aria-hidden />}
          <span>{needsSync ? "逐集状态尚未同步完整，缺集情况待确认。" : "已开播集数已全部入库，暂无缺失已播集。"}</span>
        </div>
      </div>
    );
  }

  const showPagination = filteredItems.length > PAGE_SIZE;

  return (
    <section className="missing-episodes-deck" aria-label="全部缺集总览与定向补集看板">
      <div className="missing-deck-header">
        <div className="missing-deck-title-wrap">
          <AlertCircle size={16} className="missing-deck-alert-icon" aria-hidden />
          <span className="missing-deck-title">全部缺集总览</span>
          <span className="missing-deck-badge">缺 {allMissing.length} 集</span>
        </div>

        {seasonCounts.size > 1 ? (
          <div className="missing-deck-season-tabs" role="tablist" aria-label="按季筛选缺集">
            <button
              type="button"
              className={`missing-deck-tab-btn ${seasonFilter === "all" ? "is-active" : ""}`}
              onClick={() => handleSeasonChange("all")}
            >
              全部 ({allMissing.length})
            </button>
            {Array.from(seasonCounts.entries()).map(([sNum, count]) => (
              <button
                key={sNum}
                type="button"
                className={`missing-deck-tab-btn ${seasonFilter === sNum ? "is-active" : ""}`}
                onClick={() => handleSeasonChange(sNum)}
              >
                第 {sNum} 季 ({count})
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {needsSync ? <p role="status">部分季度的逐集状态尚未同步完整，缺集列表可能不完整。</p> : null}

      <div className="missing-deck-grid">
        {paginated.items.map((item) => {
          const isTargeted =
            target?.seasonNumber === item.seasonNumber &&
            target?.episodeNumber === item.episodeNumber;

          return (
            <div
              key={item.id}
              className={`missing-episode-card ${isTargeted ? "is-targeted" : ""}`}
            >
              <div className="missing-episode-card-top">
                <span className="missing-episode-code">{item.episodeCode}</span>
                <span className="missing-episode-tag">缺</span>
              </div>
              <div className="missing-episode-card-body">
                <span className="missing-episode-desc">{item.displayCode}</span>
              </div>
              <button
                type="button"
                className={`missing-episode-search-btn ${isTargeted ? "is-active" : ""}`}
                onClick={() => handleTarget(item)}
                title={`在下方资源检索中精确定位并检索 ${item.episodeCode}`}
              >
                <Search size={11} aria-hidden />
                <span>{isTargeted ? "已定向" : "搜此集"}</span>
              </button>
            </div>
          );
        })}
      </div>

      {showPagination ? (
        <div className="missing-deck-pagination">
          <span className="missing-deck-page-info">
            第 {paginated.currentPage} / {paginated.totalPages} 页 (共 {filteredItems.length} 集)
          </span>
          <div className="missing-deck-page-actions">
            <button
              type="button"
              className="missing-deck-page-btn"
              disabled={!paginated.hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="上一页"
            >
              <ChevronLeft size={13} aria-hidden />
              <span>上一页</span>
            </button>
            <button
              type="button"
              className="missing-deck-page-btn"
              disabled={!paginated.hasNext}
              onClick={() => setPage((p) => Math.min(paginated.totalPages, p + 1))}
              aria-label="下一页"
            >
              <span>下一页</span>
              <ChevronRight size={13} aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
