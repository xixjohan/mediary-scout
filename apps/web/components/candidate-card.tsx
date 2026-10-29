import Link from "next/link";
import { AcquireProgressBadge } from "./acquire-progress-badge";
import { SeasonRequestMenu } from "./season-request-menu";
import { RequestTrackButton } from "./request-track-button";
import { showHref } from "@media-track/workflow";
import type { SearchCandidateCard } from "@media-track/workflow";
import type { DoubanRating } from "../lib/douban-rating";

function CandidateCardActions({
  acquiring,
  isTv,
  trackedLabel,
  untrackedSeasons,
  candidate,
  storageId,
  searchQuery,
}: {
  acquiring: boolean;
  isTv: boolean;
  trackedLabel: string | null;
  untrackedSeasons: number[];
  candidate: SearchCandidateCard;
  storageId?: string | undefined;
  searchQuery?: string | undefined;
}) {
  if (acquiring) {
    return (
      <AcquireProgressBadge
        tmdbId={candidate.tmdbId}
        seasonNumber={null}
        storageId={storageId}
        title="后台正在获取——点查看进度（活动）"
      />
    );
  }
  if (isTv && untrackedSeasons.length > 0) {
    return (
      <SeasonRequestMenu
        tmdbId={candidate.tmdbId}
        seasonNumbers={untrackedSeasons}
        totalSeasonCount={candidate.seasonNumbers.length}
        allLabel={trackedLabel !== null ? `获取剩余 ${untrackedSeasons.length} 季` : "获取所有季"}
        storageId={storageId}
        demoEntry={{
          tmdbId: candidate.tmdbId,
          title: candidate.title,
          year: candidate.year,
          type: candidate.mediaType,
          posterPath: candidate.posterPath,
        }}
      />
    );
  }
  if (isTv && trackedLabel !== null) {
    return (
      <Link className="primary-button" href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType, searchQuery)}>
        查看详情
      </Link>
    );
  }
  if (!isTv && trackedLabel === null) {
    return (
      <RequestTrackButton
        candidateId={candidate.id}
        tmdbId={candidate.tmdbId}
        actionState={candidate.action.state}
        disabled={candidate.action.disabled}
        label={candidate.action.label}
        storageId={storageId}
        demoEntry={{
          tmdbId: candidate.tmdbId,
          title: candidate.title,
          year: candidate.year,
          type: candidate.mediaType,
          posterPath: candidate.posterPath,
        }}
      />
    );
  }
  return null;
}

export function CandidateCard({
  candidate,
  acquiring,
  trackedLabel,
  trackedSeasonNumbers,
  storageId,
  searchQuery,
  doubanRating,
}: {
  candidate: SearchCandidateCard;
  /** This title has a queued/running acquisition — show 获取中, not its
   *  (possibly "有缺集") tracked snapshot, which is misleading mid-acquisition. */
  acquiring: boolean;
  trackedLabel: string | null;
  trackedSeasonNumbers: number[];
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId?: string | undefined;
  searchQuery?: string | undefined;
  doubanRating?: DoubanRating | undefined;
}) {
  const isTv = candidate.mediaType === "tv";
  const trackedSet = new Set(trackedSeasonNumbers);
  // Only seasons NOT yet tracked are offered as acquisition scopes.
  const untrackedSeasons = candidate.seasonNumbers.filter(
    (seasonNumber) => !trackedSet.has(seasonNumber),
  );
  return (
    <article className="candidate-card">
      <Link className="candidate-poster" href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType, searchQuery)} aria-hidden tabIndex={-1}>
        {candidate.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={candidate.posterPath.startsWith("http") ? candidate.posterPath : `https://image.tmdb.org/t/p/w342${candidate.posterPath}`}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span>{candidate.title.slice(0, 4)}</span>
        )}
      </Link>
      <div className="candidate-body">
        <div className="candidate-title-row">
          <div>
            <h3 style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Link href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType, searchQuery)}>{candidate.title}</Link>
              {candidate.source === "douban" ? (
                <span className="candidate-source-badge" title="来源：豆瓣搜索兜底">豆瓣源</span>
              ) : null}
            </h3>
            <p className="candidate-meta-line" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>{candidate.year} · {isTv ? "剧集" : "电影"}</span>
              {doubanRating ? (
                <span className="douban-badge" title={`豆瓣评分 ${doubanRating.score}${doubanRating.voteCount ? ` (${doubanRating.voteCount}人评价)` : ""}`}>
                  <span className="douban-dot">🟢</span> 豆瓣 {doubanRating.score.toFixed(1)}
                </span>
              ) : candidate.source === "douban" && candidate.voteAverage ? (
                <span className="douban-badge" title={`豆瓣评分 ${candidate.voteAverage.toFixed(1)}`}>
                  <span className="douban-dot">🟢</span> 豆瓣 {candidate.voteAverage.toFixed(1)}
                </span>
              ) : null}
            </p>
          </div>
          <div className="candidate-actions">
            <CandidateCardActions
              acquiring={acquiring}
              isTv={isTv}
              trackedLabel={trackedLabel}
              untrackedSeasons={untrackedSeasons}
              candidate={candidate}
              storageId={storageId}
              searchQuery={searchQuery}
            />
          </div>
        </div>
        {candidate.overview ? (
          <p className="candidate-overview">{candidate.overview}</p>
        ) : null}
        <div className="candidate-meta">
          {isTv && candidate.seasonNumbers.length > 0 ? (
            <span>共 {candidate.seasonNumbers.length} 季</span>
          ) : null}
          {!acquiring && trackedLabel !== null ? (
            <span className="hub-badge tone-green">{trackedLabel}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
