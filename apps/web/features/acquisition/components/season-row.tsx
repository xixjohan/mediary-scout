"use client";

import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import type { TitleHubSeason } from "../../../lib/title-hub";
import { seasonBadgeState } from "../../../lib/title-aggregate";
import { SeasonDetails } from "../../catalog/components/season-details";
import { RequestSeasonButton } from "../../catalog/components/title-action-buttons";
import { SwapEpisodeCell } from "./swap-keep";
import { MissingEpisodeCell } from "./missing-episode-cell";
import { UntrackButton } from "./untrack-button";

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

export interface SeasonRowProps {
  season: TitleHubSeason;
  tmdbId: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId: string | undefined;
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
  basePath,
  acquiring,
  swap,
  demoEntry,
  canManageMedia = true,
}: SeasonRowProps) {
  const total = season.totalEpisodes;
  const aired = Math.min(season.latestAiredEpisode, total);
  // Obtained never exceeds aired for bar purposes (resource-ahead caps at aired).
  const obtained = Math.min(season.obtainedCount, aired);
  const airedPct = total > 0 ? (aired / total) * 100 : 0;
  const obtainedPct = total > 0 ? (obtained / total) * 100 : 0;

  const badge = seasonBadge[seasonBadgeState(season)];

  const rowBody = (
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

  if (!season.tracked) {
    return (
      <li className="hub-season-row untracked">
        {rowBody}
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

  const episodes =
    season.episodes.length > 0
      ? season.episodes
      : Array.from({ length: season.totalEpisodes }, (_, i) => {
          const epNum = i + 1;
          const sPadded = String(season.seasonNumber).padStart(2, "0");
          const ePadded = String(epNum).padStart(2, "0");
          const code = `S${sPadded}E${ePadded}`;
          const isObtained = epNum <= season.obtainedCount;
          const isAired = epNum <= season.latestAiredEpisode;
          const displayState = isObtained ? "obtained" : isAired ? "missing_aired" : "unaired";
          return {
            episodeCode: code,
            airStatus: isAired ? ("aired" as const) : ("unaired" as const),
            obtained: isObtained,
            metadataStatus: "confirmed" as const,
            verifiedFileCount: isObtained ? 1 : 0,
            displayState,
          };
        });

  return (
    <li>
      <SeasonDetails initiallyOpen={episodes.some((episode) => swap.has(episode.episodeCode))}>
        <summary className="hub-season-row">{rowBody}</summary>
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
                seasonNumber={season.seasonNumber}
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
        {canManageMedia ? (
          <div className="season-untrack-row">
            <UntrackButton
              tmdbId={tmdbId}
              storageId={storageId}
              mediaKind="tv"
              seasonNumber={season.seasonNumber}
              basePath={basePath}
              label={`取消第 ${season.seasonNumber} 季追踪`}
            />
          </div>
        ) : null}
      </SeasonDetails>
    </li>
  );
}
