"use client";

import { useMemo, useState } from "react";
import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import type { TitleHubSeason } from "../../../lib/title-hub";
import { seasonBadgeState } from "../../../lib/title-aggregate";
import { SeasonDetails } from "../../catalog/components/season-details";
import { ManualSubscriptionSearchButton, RequestSeasonButton } from "../../catalog/components/title-action-buttons";
import { SwapEpisodeCell } from "./swap-keep";
import { MissingEpisodeCell } from "./missing-episode-cell";
import { UntrackButton } from "./untrack-button";
import {
  isSeasonEpisodeStateIncomplete,
  sliceSeasonEpisodes,
  SEASON_CHUNK_SIZE,
  type SeasonChunkInfo,
} from "../contracts/missing-episodes-model";

const seasonBadge = {
  untracked: null,
  missing: { label: "缺集", tone: "amber" },
  airing: { label: "追更中", tone: "indigo" },
  complete: { label: "已完结", tone: "green" },
} as const;

const EPISODE_STATE_LABEL: Record<string, string> = {
  obtained: "已获取",
  missing_aired: "缺集",
  provider_ahead: "超前",
  unaired: "未播",
  unknown: "未知",
};

interface SeasonChunkToolbarProps {
  chunks: SeasonChunkInfo[];
  currentChunk: number;
  onSelectChunk: (index: number) => void;
  onlyMissing: boolean;
  onToggleMissing: () => void;
  missingCount: number;
}

function SeasonChunkToolbar({
  chunks,
  currentChunk,
  onSelectChunk,
  onlyMissing,
  onToggleMissing,
  missingCount,
}: SeasonChunkToolbarProps) {
  return (
    <div className="season-chunk-toolbar">
      <div className="season-chunk-tabs">
        {chunks.map(({ chunkIndex, startEp, endEp }) => (
          <button
            key={chunkIndex}
            type="button"
            className={`season-chunk-pill${currentChunk === chunkIndex ? " is-active" : ""}`}
            onClick={() => onSelectChunk(chunkIndex)}
          >
            {startEp}-{endEp}
          </button>
        ))}
      </div>
      {missingCount > 0 ? (
        <button
          type="button"
          className={`season-filter-toggle${onlyMissing ? " is-active" : ""}`}
          onClick={onToggleMissing}
        >
          {onlyMissing ? "显示全部" : `只看缺集 (${missingCount})`}
        </button>
      ) : null}
    </div>
  );
}

interface SeasonRowSummaryProps {
  season: TitleHubSeason;
}

function SeasonRowSummary({ season }: SeasonRowSummaryProps) {
  const total = season.totalEpisodes;
  const aired = Math.min(season.latestAiredEpisode, total);
  // Obtained never exceeds aired for bar purposes (resource-ahead caps at aired).
  const obtained = Math.min(season.obtainedCount, aired);
  const airedPct = total > 0 ? (aired / total) * 100 : 0;
  const obtainedPct = total > 0 ? (obtained / total) * 100 : 0;

  const needsSync = isSeasonEpisodeStateIncomplete(season);
  const badge = needsSync ? { label: "待同步", tone: "muted" } : seasonBadge[seasonBadgeState(season)];

  return (
    <>
      <span className="season-cell-name">第 {season.seasonNumber} 季</span>
      <span className="season-cell-count">{total} 集</span>
      {badge ? (
        <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span>
      ) : (
        <span className="hub-badge tone-muted">未追踪</span>
      )}
      <span className="season-cell-progress" aria-hidden>
        {season.tracked ? (
          <>
            <span className="seg-aired" style={{ width: `${airedPct}%` }} />
            <span className="seg-obtained" style={{ width: `${obtainedPct}%` }} />
          </>
        ) : null}
      </span>
      {/* 已获取 / 已播 / 总集数 — so 6/6 of a 9-ep season isn't read as complete. */}
      <span className="season-cell-obtained">
        {season.tracked ? `${season.obtainedCount}/${aired}/${total}` : "—"}
      </span>
    </>
  );
}

interface SeasonEpisodeGridProps {
  episodes: readonly TitleHubSeason["episodes"][number][];
  swap: ReadonlySet<string>;
  seasonNumber: number;
}

function SeasonEpisodeGrid({ episodes, swap, seasonNumber }: SeasonEpisodeGridProps) {
  return (
    <div className="episode-grid hub-episode-grid">
      {episodes.map((episode) => {
        const stateClass = episode.displayState.replace("_", "-");
        const stateLabel = EPISODE_STATE_LABEL[episode.displayState] ?? "未知";
        // A 待换 cell is a client piece: 「不换了」 on the message card restores it at once.
        const isMissing = episode.displayState === "missing_aired";
        return swap.has(episode.episodeCode) ? (
          <SwapEpisodeCell key={episode.episodeCode} code={episode.episodeCode} stateClass={stateClass} stateLabel={stateLabel} />
        ) : isMissing ? (
          <MissingEpisodeCell
            seasonNumber={seasonNumber}
            stateClass={stateClass}
            key={episode.episodeCode}
            code={episode.episodeCode}
            stateLabel={stateLabel}
          />
        ) : (
          <div className={`episode-cell ${stateClass}`} key={episode.episodeCode}>
            <strong>{episode.episodeCode.replace(/^S\d+/, "")}</strong>
            <span>{stateLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

interface SeasonSubscriptionActionsProps {
  tmdbId: number;
  mediaType: "tv" | "anime";
  seasonNumber: number;
  storageId: string | undefined;
  isAcquiring: boolean;
  missingAiredCount: number;
  needsSync: boolean;
  basePath: string;
}

function SeasonSubscriptionActions({
  tmdbId,
  mediaType,
  seasonNumber,
  storageId,
  isAcquiring,
  missingAiredCount,
  needsSync,
  basePath,
}: SeasonSubscriptionActionsProps) {
  const disabledReason = !needsSync && missingAiredCount === 0 ? "当前没有待搜索的已播缺集。" : undefined;

  return (
    <div className="season-subscription-actions">
      <ManualSubscriptionSearchButton
        tmdbId={tmdbId}
        mediaType={mediaType}
        seasonNumber={seasonNumber}
        storageId={storageId}
        activityHref={storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity"}
        isAcquiring={isAcquiring}
        disabledReason={disabledReason}
      />
      <div className="season-untrack-row">
        <UntrackButton
          tmdbId={tmdbId}
          storageId={storageId}
          mediaKind="tv"
          seasonNumber={seasonNumber}
          basePath={basePath}
          label={`取消第 ${seasonNumber} 季追踪`}
        />
      </div>
    </div>
  );
}

export interface SeasonRowProps {
  season: TitleHubSeason;
  tmdbId: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId: string | undefined;
  mediaType: "tv" | "anime";
  /** Library path to return to after a whole-show untrack. */
  basePath: string;
  acquiring: boolean;
  /** Episodes a user asked to replace that are still 待换 (their old file stays). */
  swap: ReadonlySet<string>;
  demoEntry?: DemoAcquisitionEntry | undefined;
  canManageMedia?: boolean;
}

export function SeasonRow({
  season,
  tmdbId,
  storageId,
  mediaType,
  basePath,
  acquiring,
  swap,
  demoEntry,
  canManageMedia = true,
}: SeasonRowProps) {
  const needsSync = isSeasonEpisodeStateIncomplete(season);

  if (!season.tracked) {
    return (
      <li className="hub-season-row untracked">
        <SeasonRowSummary season={season} />
        <RequestSeasonButton
          tmdbId={tmdbId}
          seasonNumber={season.seasonNumber}
          storageId={storageId}
          titleAcquiring={acquiring}
          demoEntry={demoEntry}
        />
      </li>
    );
  }

  const episodes = season.episodes;
  const isLongSeason = episodes.length > SEASON_CHUNK_SIZE;
  const [chunkIndex, setChunkIndex] = useState(0);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const filteredEpisodes = useMemo(() => {
    if (!onlyMissing) return episodes;
    return episodes.filter((ep) => ep.displayState === "missing_aired" || swap.has(ep.episodeCode));
  }, [episodes, onlyMissing, swap]);

  const { chunks, currentChunk, sliced: displayedEpisodes } = useMemo(() => {
    return sliceSeasonEpisodes(filteredEpisodes, chunkIndex, SEASON_CHUNK_SIZE);
  }, [filteredEpisodes, chunkIndex]);

  const showToolbar = isLongSeason || (onlyMissing && filteredEpisodes.length !== episodes.length);

  return (
    <li>
      <SeasonDetails initiallyOpen={episodes.some((episode) => swap.has(episode.episodeCode))}>
        <summary className="hub-season-row">
          <SeasonRowSummary season={season} />
        </summary>
        {needsSync ? <p role="status">逐集状态尚未同步完整，缺集情况待确认。</p> : null}
        {showToolbar ? (
          <SeasonChunkToolbar
            chunks={chunks}
            currentChunk={currentChunk}
            onSelectChunk={setChunkIndex}
            onlyMissing={onlyMissing}
            onToggleMissing={() => {
              setOnlyMissing((prev) => !prev);
              setChunkIndex(0);
            }}
            missingCount={season.missingAiredCount}
          />
        ) : null}
        <SeasonEpisodeGrid
          episodes={displayedEpisodes}
          swap={swap}
          seasonNumber={season.seasonNumber}
        />
        {canManageMedia ? (
          <SeasonSubscriptionActions
            tmdbId={tmdbId}
            mediaType={mediaType}
            seasonNumber={season.seasonNumber}
            storageId={storageId}
            isAcquiring={season.acquiring ?? false}
            missingAiredCount={season.missingAiredCount}
            needsSync={needsSync}
            basePath={basePath}
          />
        ) : null}
      </SeasonDetails>
    </li>
  );
}
