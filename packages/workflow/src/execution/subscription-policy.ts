/**
 * Batch 5: the subscription strategy layer's decision core (plan §4.1 / 批次 5).
 *
 * The plan is emphatic about what this is NOT: **do not build a `subscription.status`
 * state machine.** Sonarr's own words are that Missing means *"in the database,
 * monitored, but missing from the filesystem"* — monitored/missing is two switches plus
 * four derived queries, not three state fields. MP likewise has four states and derives
 * progress rather than storing it. So this module stores no status at all: it answers
 * "does this resource satisfy this policy", and everything else is derived.
 *
 * The field set is lifted from qBittorrent's rule UI, per the plan: `mustContain` /
 * `mustNotContain`, `episodeFilter` (`S01-S03;E01-E10`), `useRegex`, `cooldownDays`.
 * Those names are deliberately not renamed — a user who has configured qBittorrent
 * should not have to relearn the vocabulary.
 *
 * Everything here is pure. No DB, no drive, no clock (the caller passes `now`). That is
 * what makes 规则预览 — the plan's "low cost, high value" companion — testable without
 * a search: preview runs the SAME matcher over the SAME resource names, so what it
 * promises is what the run will do.
 */

import { matchIdentityByName, type TitleIdentity } from "./title-identity.js";

/** A resource a policy is asked about. Only what matching needs — no drive URLs. */
export interface PolicyResource {
  /** The resource's display name, as the search returned it. */
  name: string;
  /** Present when the resource carries episode information. */
  episodeCode?: string | null;
}

/**
 * The strategy, decoupled from the monitored target so it can be reused (plan 四件套 ③).
 *
 * `mustContain` / `mustNotContain` are lists, not strings: qBittorrent's rule UI takes
 * one term per line, and a user pasting a multi-line value expects each line to be a
 * term rather than one giant substring.
 */
export interface SubscriptionPolicy {
  /** Every term must appear (case-insensitive substring, or regex when `useRegex`). */
  mustContain: string[];
  /** No term may appear. Evaluated first: an exclusion is cheaper than an inclusion. */
  mustNotContain: string[];
  /** Restrict to these seasons/episodes, e.g. `S01-S03;E01-E10`. Empty = no restriction. */
  episodeFilter: string;
  /** Treat the terms above as regular expressions. */
  useRegex: boolean;
  /** Days to ignore further matches after one is taken (qBittorrent's "Ignore subsequent
   *  matches for"). 0 = no cooldown. */
  cooldownDays: number;
  /** User-defined custom search keywords to use during search / automated patrol. */
  customKeywords?: string[];
  /** Ordered fallback groups. First matching group wins; empty means no ranking gate. */
  priorityGroups?: SubscriptionPriorityGroup[];
  /** Optional per-season inclusive episode ranges; an absent season has no extra bound. */
  seasonEpisodeRanges?: SeasonEpisodeRange[];
  /** 字幕偏好：软偏好（加分/标注），`require` 时才作为准入硬条件。 */
  subtitlePreference?: SubtitlePreference;
  /** 画质截止线 (Quality Cutoff)，达到此档位后不再触发升级搜索与下载，默认不设限 */
  qualityCutoff?: QualityCutoffTier;
  /** 是否允许洗版升级 (默认 false，不开启则已有文件绝不再替换) */
  allowUpgrade?: boolean;
}

/**
 * 字幕偏好。
 *
 * 与 `mustContain` 分开建模，是因为真实标题里「有中文字幕」的写法不止一种：
 * `CHS`、`CHS-ENG`、`中英双字`、`简繁`、`双语`、`中字`、`内嵌`。把它做成
 * `mustContain: ["简中字幕"]` 那样的 AND 子串，等于要求标题出现「简中字幕」四个字
 * 连写——实测多数资源不这么写，规则恒 false。
 *
 * 因此这里是 OR 词表（任一词命中即有字幕），且默认 `require: false`：有字幕的候选
 * 排在无字幕的前面，但不把无字幕的整个排除。用户显式勾「必须有中文字幕」才变成硬条件。
 */
export interface SubtitlePreference {
  /** 任一词命中即视为有字幕（OR，不区分大小写；useRegex 时按正则）。 */
  terms: string[];
  /** true = 无字幕候选在准入阶段被拒（reason: subtitle_missing）。 */
  require: boolean;
}

/** 默认字幕词表：覆盖本仓实测过的主流写法（见 modules 注释）。 */
export const DEFAULT_SUBTITLE_TERMS: readonly string[] = [
  "简中",
  "简日",
  "CHS",
  "简繁",
  "双语",
  "中英",
  "中字",
  "内嵌",
  "字幕",
];

export const DEFAULT_SUBTITLE_PREFERENCE: SubtitlePreference = {
  require: false,
  terms: [...DEFAULT_SUBTITLE_TERMS],
};


export interface SeasonEpisodeRange {
  seasonNumber: number;
  startEpisode: number;
  endEpisode: number | null;
}

export interface SubscriptionPriorityGroup {
  id: string;
  name: string;
  mustContain: string[];
  mustNotContain: string[];
}


export type QualityCutoffTier = "720p" | "1080p" | "2160p" | "none";

const QUALITY_RANKS: Record<QualityCutoffTier, number> = {
  none: 0,
  "720p": 1,
  "1080p": 2,
  "2160p": 3,
};

/**
 * 从名称或标签中解析画质分级档位
 */
export function parseQualityTier(titleOrName: string): QualityCutoffTier {
  if (/(?:4k|2160p|uhd)/i.test(titleOrName)) return "2160p";
  if (/(?:1080p|fhd)/i.test(titleOrName)) return "1080p";
  if (/(?:720p|hd)/i.test(titleOrName)) return "720p";
  return "none";
}

/**
 * 判断当前已有版本是否已经满足设定的画质截止线 (Quality Cutoff)
 * 满足后巡检应停止任何更高画质版本的搜寻与下载，彻底杜绝洗版造成的配额浪费。
 */
export function isQualityCutoffMet(currentQualityName: string, cutoffTier?: QualityCutoffTier): boolean {
  if (!cutoffTier || cutoffTier === "none") return false;
  const currentTier = parseQualityTier(currentQualityName);
  return QUALITY_RANKS[currentTier] >= QUALITY_RANKS[cutoffTier];
}

export const EMPTY_POLICY: SubscriptionPolicy = {
  mustContain: [],
  mustNotContain: [],
  episodeFilter: "",
  useRegex: false,
  cooldownDays: 0,
  customKeywords: [],
  priorityGroups: [],
  seasonEpisodeRanges: [],
};

/**
 * Parse an episode filter into the set of episode codes it admits.
 *
 * Grammar (a deliberate subset of qBittorrent's):
 *   `S01-S03`   seasons 1 through 3, any episode
 *   `E01-E10`   those episode numbers, any season
 *   `S02E05`    exactly that episode
 *   `;`         separates independent clauses; the result is their union
 *
 * An unparseable clause yields null rather than a partial answer — a filter that
 * silently matches less than the user wrote is how a subscription quietly stops
 * working. The caller decides what to do with null (reject the policy, or warn).
 */
export function parseEpisodeFilter(filter: string): Set<string> | null {
  const trimmed = filter.trim();
  if (trimmed.length === 0) return new Set();

  const admitted = new Set<string>();
  for (const clause of trimmed.split(";")) {
    if (!parseEpisodeFilterClause(clause.trim(), admitted)) return null;
  }
  return admitted;
}

/**
 * The grammar, one row per form.
 *
 * Table-driven rather than a chain of `if`s: the six forms are the whole vocabulary of
 * an episode filter, and a reader should be able to see all of them at once instead of
 * counting branches. `admit` returns false only when a range is backwards or out of
 * bounds — an empty clause (`S01;;E05`) is handled by the caller, which skips it.
 */
const CLAUSE_FORMS: {
  pattern: RegExp;
  /** The pattern's capture groups, in order — a row reads the group it cares about. */
  admit: (groups: readonly string[], admitted: Set<string>) => boolean;
}[] = [
  {
    // S01-S03 — seasons 1..3, any episode. 99 is the cap because the pattern allows
    // only two digits; a season number that large is a typo, not a target.
    pattern: /^[Ss](\d{1,2})-[Ss](\d{1,2})$/,
    admit: (groups, admitted) => {
      const from = Number(groups[1]);
      const to = Number(groups[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || to > 99) return false;
      for (let season = from; season <= to; season += 1) {
        admitted.add(`S${String(season).padStart(2, "0")}`);
      }
      return true;
    },
  },
  {
    // E01-E10 — those episode numbers, any season.
    pattern: /^[Ee](\d{1,4})-[Ee](\d{1,4})$/,
    admit: (groups, admitted) => {
      const from = Number(groups[1]);
      const to = Number(groups[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return false;
      for (let episode = from; episode <= to; episode += 1) {
        admitted.add(`E${String(episode).padStart(2, "0")}`);
      }
      return true;
    },
  },
  {
    // S02E05 — exactly that episode.
    pattern: /^[Ss](\d{1,2})[Ee](\d{1,4})$/,
    admit: (groups, admitted) => {
      admitted.add(`S${groups[1]!.padStart(2, "0")}E${groups[2]!.padStart(2, "0")}`);
      return true;
    },
  },
  {
    // S01 — a single season, any episode. This is the one-value case of the range form,
    // and what most users actually write.
    pattern: /^[Ss](\d{1,2})$/,
    admit: (groups, admitted) => {
      admitted.add(`S${groups[1]!.padStart(2, "0")}`);
      return true;
    },
  },
  {
    // E01 — a single episode number, any season.
    pattern: /^[Ee](\d{1,4})$/,
    admit: (groups, admitted) => {
      admitted.add(`E${groups[1]!.padStart(2, "0")}`);
      return true;
    },
  },
  {
    // 05 — a bare episode number, same as E01.
    pattern: /^(\d{1,4})$/,
    admit: (groups, admitted) => {
      admitted.add(`E${groups[1]!.padStart(2, "0")}`);
      return true;
    },
  },
];

/**
 * Parse ONE clause into `admitted`. Returns false when the clause is not understood —
 * which makes the whole filter null rather than a partial answer (see the header).
 */
function parseEpisodeFilterClause(text: string, admitted: Set<string>): boolean {
  if (text.length === 0) return true;
  for (const form of CLAUSE_FORMS) {
    const match = form.pattern.exec(text);
    // Every form requires at least one group, so a match without one is a pattern bug
    // rather than a clause to interpret.
    if (match === null || match[1] === undefined) continue;
    return form.admit(match, admitted);
  }
  return false;
}

/** Normalize a term for comparison. qBittorrent matches case-insensitively. */
function normalizeTerm(term: string, useRegex: boolean): string {
  return useRegex ? term : term.trim().toLowerCase();
}

/** Whether one term matches a name. A bad regex does not throw — it excludes. */
function termMatches(term: string, name: string, useRegex: boolean): boolean {
  if (term.length === 0) return false;
  if (!useRegex) return name.toLowerCase().includes(term.trim().toLowerCase());
  try {
    return new RegExp(term, "i").test(name);
  } catch {
    // An invalid pattern excludes rather than crashing the whole patrol.
    return false;
  }
}

/**
 * The season / episode a resource claims, or null when it claims none.
 * `episodeCode` wins when present; otherwise the name is parsed.
 */
function resourceEpisodes(resource: PolicyResource): { season: string | null; episode: string | null } {
  const code = resource.episodeCode ?? /[Ss](\d{1,2})[Ee](\d{1,4})/.exec(resource.name);
  if (typeof code === "string") {
    const match = /^S(\d{1,2})E(\d{1,4})$/.exec(code);
    if (match?.[1] && match[2]) {
      return { season: `S${match[1]}`, episode: `E${match[2]}` };
    }
    return { season: null, episode: null };
  }
  if (code === null) return { season: null, episode: null };
  const season = `S${code[1]!.padStart(2, "0")}`;
  const episode = `E${code[2]!.padStart(2, "0")}`;
  return { season, episode };
}

/**
 * 整季/全集包：`全N集`、`第N季`（不带具体集号）、`SxxEyy-zz` 区间。
 *
 * 与 `describesEpisodePack` 的区别：后者只认集号区间（用于「先别把季包按单集范围
 * 拒掉」），这里还要认中文 `全12集` —— 计数语义需要它来区分「一条 = 一季」与
 * 「一条 = 一集」。
 */
export function isSeasonPackName(name: string): boolean {
  if (/全\s*\d{1,4}\s*集/.test(name)) return true;
  if (/第\s*\d{1,2}\s*季/.test(name) && !/[Ss]\d{1,2}[Ee]\d{1,4}/.test(name)) return true;
  return describesEpisodePack(name);
}

/** A release title can describe a whole episode interval; defer its range decision
 * until the archive is inspected file by file. This avoids dropping a season pack
 * because its title starts before the user's requested episode. */
function describesEpisodePack(name: string): boolean {
  return /[Ss]\d{1,2}[Ee]\d{1,4}\s*(?:-|~|至)\s*[Ee]?\d{1,4}/i.test(name);
}

export type PolicyVerdict = { matched: true; priorityGroupId?: string; priorityGroupName?: string; hasSubtitle?: boolean } | { matched: false; reason: PolicyRejectReason };

export type PolicyRejectReason =
  /** A `mustNotContain` term hit. */
  | "excluded"
  /** A `mustContain` term was missing. */
  | "missing_term"
  /** The episode filter does not admit this episode. */
  | "episode_filtered"
  /** 必须中文字幕，但标题里没有任何字幕标记。 */
  | "subtitle_missing"
  /** 这条资源根本不是这部作品（不同 tmdb id / 相差多年的年份 / 片名对不上）。 */
  | "wrong_title"
  | "priority_unmatched";

export interface MatchPolicyOptions {
  /** File validation runs after unpacking and must reject video files without usable season/episode metadata. */
  requireSeasonEpisodeForRange?: boolean;
  /**
   * 作品身份。提供时，身份闸门作为**第一步**执行——先确认「这是不是这部作品」，
   * 再套任何版本词。缺省（不提供）时行为与引入身份闸门之前完全一致，既有纯单测
   * 无需改动。
   */
  identity?: TitleIdentity;
}

function matchPriorityGroup(policy: SubscriptionPolicy, name: string): PolicyVerdict {
  const groups = policy.priorityGroups ?? [];
  for (const group of groups) {
    if (group.mustContain.length === 0 && group.mustNotContain.length === 0) continue;
    const excluded = group.mustNotContain.some((term) => termMatches(term, name, policy.useRegex));
    const included = group.mustContain.every((term) => termMatches(term, name, policy.useRegex));
    if (!excluded && included) return { matched: true, priorityGroupId: group.id, priorityGroupName: group.name };
  }
  return groups.length > 0 ? { matched: false, reason: "priority_unmatched" } : { matched: true };
}

function matchPolicyTerms(policy: SubscriptionPolicy, name: string): PolicyVerdict {
  for (const term of policy.mustNotContain) {
    if (termMatches(normalizeTerm(term, policy.useRegex), name, policy.useRegex)) return { matched: false, reason: "excluded" };
  }
  for (const term of policy.mustContain) {
    if (!termMatches(normalizeTerm(term, policy.useRegex), name, policy.useRegex)) return { matched: false, reason: "missing_term" };
  }
  return { matched: true };
}

function matchSeasonEpisodeRanges(policy: SubscriptionPolicy, resource: PolicyResource, options: MatchPolicyOptions): PolicyVerdict {
  const ranges = policy.seasonEpisodeRanges ?? [];
  if (ranges.length === 0 || (!options.requireSeasonEpisodeForRange && describesEpisodePack(resource.name))) return { matched: true };
  const { season, episode } = resourceEpisodes(resource);
  if ((season === null || episode === null) && options.requireSeasonEpisodeForRange) return { matched: false, reason: "episode_filtered" };
  const range = season === null ? undefined : ranges.find((entry) => entry.seasonNumber === Number(season.slice(1)));
  if (!range || episode === null) return { matched: true };
  const episodeNumber = Number(episode.slice(1));
  return episodeNumber < range.startEpisode || (range.endEpisode !== null && episodeNumber > range.endEpisode)
    ? { matched: false, reason: "episode_filtered" }
    : { matched: true };
}

function matchEpisodeFilter(policy: SubscriptionPolicy, resource: PolicyResource): PolicyVerdict {
  const admitted = parseEpisodeFilter(policy.episodeFilter);
  if (admitted === null) return { matched: false, reason: "episode_filtered" };
  if (admitted.size === 0) return { matched: true };
  const { season, episode } = resourceEpisodes(resource);
  const admittedResource =
    (season !== null && admitted.has(season)) ||
    (episode !== null && admitted.has(episode)) ||
    // An exact `SxxEyy` clause admits only that pair.
    (season !== null && episode !== null && admitted.has(`${season}${episode}`));
  return admittedResource ? { matched: true } : { matched: false, reason: "episode_filtered" };
}

/**
 * 字幕偏好的判定：返回「有字幕吗」+ 是否需要因缺字幕而拒绝。
 *
 * 这是 OR 词表 —— 任一词命中即算有字幕。空词表等价「不关心」，不拒绝任何东西。
 * `require: false`（默认）只在结果里附带 `hasSubtitle` 供排序与预览标注，不参与准入。
 */
function matchSubtitlePreference(policy: SubscriptionPolicy, name: string): { hasSubtitle: boolean; verdict: PolicyVerdict | null } {
  const preference = policy.subtitlePreference;
  if (!preference) return { hasSubtitle: false, verdict: null };
  const terms = preference.terms.filter((term) => term.trim().length > 0);
  if (terms.length === 0) return { hasSubtitle: false, verdict: null };
  const hasSubtitle = terms.some((term) => termMatches(term.trim(), name, policy.useRegex));
  if (!hasSubtitle && preference.require) {
    return { hasSubtitle: false, verdict: { matched: false, reason: "subtitle_missing" } };
  }
  return { hasSubtitle, verdict: null };
}

/**
 * Whether a resource satisfies a policy. Pure, and the single implementation both the
 * patrol and 规则预览 call — that shared core is the whole point: a preview that
 * promises what the run will not do is worse than no preview.
 */
export function matchPolicy(policy: SubscriptionPolicy, resource: PolicyResource, options: MatchPolicyOptions = {}): PolicyVerdict {
  const name = resource.name;
  // 身份闸门必须最先跑：没确认是同一部作品之前，版本词再漂亮也没有意义。
  if (options.identity !== undefined) {
    const identity = matchIdentityByName(options.identity, name);
    if (!identity.matched) return { matched: false, reason: "wrong_title" };
  }
  const terms = matchPolicyTerms(policy, name);
  if (!terms.matched) return terms;
  const seasonRange = matchSeasonEpisodeRanges(policy, resource, options);
  if (!seasonRange.matched) return seasonRange;
  const episodeFilter = matchEpisodeFilter(policy, resource);
  if (!episodeFilter.matched) return episodeFilter;
  const subtitle = matchSubtitlePreference(policy, name);
  if (subtitle.verdict !== null && !subtitle.verdict.matched) return subtitle.verdict;
  const priority = matchPriorityGroup(policy, name);
  if (!priority.matched) return priority;
  return { ...priority, hasSubtitle: subtitle.hasSubtitle };
}

export interface PolicyPreview {
  /** Resources the policy admits. */
  matched: PolicyResource[];
  /** Resources it rejects, each with why — so the preview can explain itself. */
  excluded: { resource: PolicyResource; reason: PolicyRejectReason }[];
  matchedCount: number;
  excludedCount: number;
  /** 命中且带中文字幕标记的条数（软偏好默认不拒，只用于展示与排序）。 */
  matchedWithSubtitleCount: number;
  /** 命中里整季包（`全N集` / 季包标题）的条数：与单集候选不是同一单位。 */
  matchedPackCount: number;
  /** 按 reason 分组的排除计数（含 wrong_title），供诊断与审计。 */
  excludedByReason: Partial<Record<PolicyRejectReason, number>>;
}

/**
 * 规则预览 (plan §4.1, "保存前用当前搜索结果试跑，告诉用户「这条规则会命中 3 个、
 * 排除 7 个」").
 *
 * Runs the SAME `matchPolicy` over the SAME names the patrol would see, so the numbers
 * are a promise rather than an estimate. The excluded list carries reasons because a
 * preview that only says "7 excluded" sends the user back to guess which rule did it.
 */
export function previewPolicy(
  policy: SubscriptionPolicy,
  resources: readonly PolicyResource[],
  options: MatchPolicyOptions = {},
): PolicyPreview {
  const matched: PolicyResource[] = [];
  const excluded: { resource: PolicyResource; reason: PolicyRejectReason }[] = [];
  let matchedWithSubtitleCount = 0;
  let matchedPackCount = 0;
  const excludedByReason: Partial<Record<PolicyRejectReason, number>> = {};
  for (const resource of resources) {
    const verdict = matchPolicy(policy, resource, options);
    if (verdict.matched) {
      matched.push(resource);
      if (verdict.hasSubtitle) matchedWithSubtitleCount += 1;
      if (isSeasonPackName(resource.name)) matchedPackCount += 1;
    } else {
      excluded.push({ resource, reason: verdict.reason });
      excludedByReason[verdict.reason] = (excludedByReason[verdict.reason] ?? 0) + 1;
    }
  }
  return {
    matched,
    excluded,
    matchedCount: matched.length,
    excludedCount: excluded.length,
    matchedWithSubtitleCount,
    matchedPackCount,
    excludedByReason,
  };
}

/**
 * Whether a resource is still inside its cooldown window.
 *
 * `now` is passed in rather than read: the plan's cost model is "periodic full re-search
 * + fingerprint dedup + cooldown", and a cooldown that reads the clock cannot be tested
 * at a boundary. `lastTakenAt` is the moment a match was last accepted.
 */
export function withinCooldown(input: {
  policy: SubscriptionPolicy;
  lastTakenAt: string | null;
  now: string;
}): boolean {
  if (input.policy.cooldownDays <= 0 || input.lastTakenAt === null) return false;
  const taken = Date.parse(input.lastTakenAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(taken) || !Number.isFinite(now)) {
    // An unreadable timestamp is not evidence of a cooldown. Failing open here means one
    // more search; failing closed would silently stop the subscription forever.
    return false;
  }
  const elapsedDays = (now - taken) / 86_400_000;
  return elapsedDays < input.policy.cooldownDays;
}
