export type TitleAggregateState = "untracked" | "tracking" | "partial" | "complete";

/**
 * The minimal per-season facts needed to decide a title's aggregate state.
 * `TitleHubSeason` satisfies this structurally.
 */
export interface AggregateSeasonInput {
  tracked: boolean;
  status: "active" | "completed" | null;
  obtainedCount: number;
  latestAiredEpisode: number;
  totalEpisodes: number;
}

/** Aired episodes that SHOULD be in storage for this season. */
function airedEpisodes(season: AggregateSeasonInput): number {
  return Math.min(season.latestAiredEpisode, season.totalEpisodes);
}

export type SeasonBadgeState = "untracked" | "missing" | "airing" | "complete";

/**
 * The single source of truth for "how complete is this one season".
 *
 * A season is fully in storage only when its obtained count reaches its aired
 * count — the SAME aired-vs-obtained test the library wall and search surface
 * use (`obtained < aired`). Do NOT decide completeness from materialized
 * episode states (e.g. missingAiredCount): a failed or never-materialized
 * acquisition leaves a "completed" season with 0 episode states, which reads
 * as "nothing missing" and falsely reports 已全部入库/已完结 for a 0/N show.
 * Both the title aggregate and the per-season row badge derive from this, so
 * the bug cannot recur on one surface while another is fixed.
 */
export function seasonBadgeState(season: AggregateSeasonInput): SeasonBadgeState {
  if (!season.tracked) {
    return "untracked";
  }
  if (season.obtainedCount < airedEpisodes(season)) {
    return "missing";
  }
  return season.status === "active" ? "airing" : "complete";
}

export type LibraryWallStateValue = "reserved" | "tracking" | "complete" | "partial";

/**
 * The poster-wall card state for a whole title. `reserved` (未上映电影) is a
 * first-class state that takes precedence: a reserved movie's anchor season reads
 * aired=1/obtained=0, which would otherwise fall into `partial` (有缺集 ⚠️) and
 * misrepresent a film that simply hasn't released yet. The released-title logic
 * mirrors the per-season test (`obtained < aired` ⇒ behind).
 */
export function libraryWallState(input: {
  obtained: number;
  aired: number;
  anyActive: boolean;
  unreleased: boolean;
}): LibraryWallStateValue {
  if (input.unreleased) {
    return "reserved";
  }
  if (input.obtained < input.aired) {
    return "partial";
  }
  return input.anyActive ? "tracking" : "complete";
}

/**
 * Is the title still releasing new episodes? True when ANY tracked season is
 * active. This is ORTHOGONAL to completeness: a 缺集 (partial) title whose latest
 * season is still airing is both — so the card/detail draw the ⚠️ AND the 追更中
 * badge instead of letting 缺集 swallow the still-updating signal (达顿牧场 vs
 * 斗破苍穹). A finished title (no active season) is not airing.
 */
export function aggregateAiring(seasons: AggregateSeasonInput[]): boolean {
  return seasons.some((season) => season.tracked && season.status === "active");
}

/**
 * The poster-wall counterpart of {@link aggregateAiring}, fed the already-reduced
 * `anyActive`. A reserved (unreleased) movie is never "airing" — it simply hasn't
 * come out — so the dual badge can't appear on it.
 */
export function libraryWallAiring(input: { anyActive: boolean; unreleased: boolean }): boolean {
  return input.anyActive && !input.unreleased;
}

export function aggregateStateFromSeasons(seasons: AggregateSeasonInput[]): TitleAggregateState {
  const states = seasons.map(seasonBadgeState);
  if (states.every((state) => state === "untracked")) {
    return "untracked";
  }
  if (states.some((state) => state === "untracked" || state === "missing")) {
    return "partial";
  }
  return states.some((state) => state === "airing") ? "tracking" : "complete";
}
