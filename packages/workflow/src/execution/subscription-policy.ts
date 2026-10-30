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
}

export const EMPTY_POLICY: SubscriptionPolicy = {
  mustContain: [],
  mustNotContain: [],
  episodeFilter: "",
  useRegex: false,
  cooldownDays: 0,
  customKeywords: [],
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

export type PolicyVerdict = { matched: true } | { matched: false; reason: PolicyRejectReason };

export type PolicyRejectReason =
  /** A `mustNotContain` term hit. */
  | "excluded"
  /** A `mustContain` term was missing. */
  | "missing_term"
  /** The episode filter does not admit this episode. */
  | "episode_filtered";

/**
 * Whether a resource satisfies a policy. Pure, and the single implementation both the
 * patrol and 规则预览 call — that shared core is the whole point: a preview that
 * promises what the run will not do is worse than no preview.
 */
export function matchPolicy(policy: SubscriptionPolicy, resource: PolicyResource): PolicyVerdict {
  const name = resource.name;

  for (const term of policy.mustNotContain) {
    if (termMatches(normalizeTerm(term, policy.useRegex), name, policy.useRegex)) {
      return { matched: false, reason: "excluded" };
    }
  }

  for (const term of policy.mustContain) {
    if (!termMatches(normalizeTerm(term, policy.useRegex), name, policy.useRegex)) {
      return { matched: false, reason: "missing_term" };
    }
  }

  const admitted = parseEpisodeFilter(policy.episodeFilter);
  if (admitted === null) {
    // An unparseable filter excludes everything: matching against a filter we could not
    // read would be a guess about what the user meant.
    return { matched: false, reason: "episode_filtered" };
  }
  if (admitted.size > 0) {
    const { season, episode } = resourceEpisodes(resource);
    const ok =
      (season !== null && admitted.has(season)) ||
      (episode !== null && admitted.has(episode)) ||
      // An exact `SxxEyy` clause admits only that pair.
      (season !== null && episode !== null && admitted.has(`${season}${episode}`));
    if (!ok) return { matched: false, reason: "episode_filtered" };
  }

  return { matched: true };
}

export interface PolicyPreview {
  /** Resources the policy admits. */
  matched: PolicyResource[];
  /** Resources it rejects, each with why — so the preview can explain itself. */
  excluded: { resource: PolicyResource; reason: PolicyRejectReason }[];
  matchedCount: number;
  excludedCount: number;
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
): PolicyPreview {
  const matched: PolicyResource[] = [];
  const excluded: { resource: PolicyResource; reason: PolicyRejectReason }[] = [];
  for (const resource of resources) {
    const verdict = matchPolicy(policy, resource);
    if (verdict.matched) {
      matched.push(resource);
    } else {
      excluded.push({ resource, reason: verdict.reason });
    }
  }
  return { matched, excluded, matchedCount: matched.length, excludedCount: excluded.length };
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
