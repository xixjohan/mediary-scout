/**
 * Batch 5: persistence shape for the subscription strategy layer (plan §4.1 四件套 ③).
 *
 * The plan asks for an **independent policy table** — not a status column on the
 * monitored target, and not a state machine. One row per (account, work), holding the
 * qBittorrent field set as-is.
 *
 * ## Why a corrupt row throws instead of degrading to "no policy"
 *
 * This is the one decision that matters here. An unreadable policy has two candidate
 * readings, and they are not equally safe:
 *
 *   · **Degrade to empty** — `mustNotContain: []` means *exclude nothing*, so a corrupt
 *     row lands exactly the resources the user ruled out. It looks like "the filter is
 *     off" and silently undoes the user's intent.
 *   · **Throw** — the caller sees a real error and can decide. A preference that cannot
 *     be read is not a preference to guess at.
 *
 * Note this is the OPPOSITE of the dead-link and rejected-resources stores, which fail
 * open for ordinary runs (a patrol must not die because a lookup failed). Those guard
 * against *landing a known-bad thing*; this one expresses *what the user wants*, and
 * guessing at it is worse than stopping. The adapter already documents that a throwing
 * `policyFilter.accept` fails the search rather than passing everything through.
 *
 * `useRegex` is stored as 0/1 — SQLite has no boolean, and a `"true"`/`"false"` string
 * would need parsing on every read.
 */

import {
  EMPTY_POLICY,
  type SubscriptionPolicy,
} from "../execution/subscription-policy.js";

/** The persisted row: the policy plus its scope and timestamps. */
export interface StoredSubscriptionPolicy extends SubscriptionPolicy {
  accountId: string;
  /** The work (title) this policy governs. Same key shape as `rejected_resources`. */
  titleKey: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When a resource was last accepted under this policy — the `cooldownDays` source
   * (qBittorrent's "Ignore subsequent matches for"). null = never took anything.
   *
   * Deliberately NOT `updatedAt`: that is when the user last edited the rule, which has
   * nothing to do with when it last matched. Using it would make every rule edit look
   * like a fresh match and reset the cooldown the user just set.
   */
  lastTakenAt: string | null;
}

/** The DB row, as SQLite returns it. Term lists are JSON; booleans are 0/1. */
export interface SubscriptionPolicyRow {
  account_id: string;
  title_key: string;
  must_contain: string;
  must_not_contain: string;
  episode_filter: string;
  use_regex: number;
  cooldown_days: number;
  created_at: string;
  updated_at: string;
  last_taken_at: string | null;
  custom_keywords?: string | null;
}

/**
 * Serialize a policy's term lists. Always emits a JSON array, never `null` — a `null`
 * column would have to be special-cased on every read.
 */
export function serializeTermList(terms: readonly string[]): string {
  return JSON.stringify(terms.map((term) => term.trim()));
}

/**
 * Parse a stored term list.
 *
 * Throws on anything that is not a JSON array of strings. An empty array is a valid,
 * meaningful value ("no terms"), so it is NOT an error — but `"[]"` arriving where
 * `'["2160p"]'` was written is a corruption we must not paper over.
 */
export function parseTermList(raw: string, column: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`subscription_policies.${column} is not valid JSON: ${raw.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`subscription_policies.${column} is not an array: ${raw.slice(0, 120)}`);
  }
  for (const term of parsed) {
    if (typeof term !== "string") {
      throw new Error(`subscription_policies.${column} has a non-string term: ${JSON.stringify(term).slice(0, 120)}`);
    }
  }
  return parsed as string[];
}

/** A DB row → the domain policy. Throws on a corrupt row (see the header). */
export function subscriptionPolicyFromRow(row: SubscriptionPolicyRow): StoredSubscriptionPolicy {
  return {
    accountId: row.account_id,
    titleKey: row.title_key,
    mustContain: parseTermList(row.must_contain, "must_contain"),
    mustNotContain: parseTermList(row.must_not_contain, "must_not_contain"),
    episodeFilter: row.episode_filter,
    useRegex: row.use_regex === 1,
    cooldownDays: row.cooldown_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTakenAt: row.last_taken_at ?? null,
    customKeywords: row.custom_keywords ? parseTermList(row.custom_keywords, "custom_keywords") : [],
  };
}

/** The domain policy → the values a write needs (without the timestamps). */
export interface SubscriptionPolicyWrite {
  mustContain: readonly string[];
  mustNotContain: readonly string[];
  episodeFilter: string;
  useRegex: boolean;
  cooldownDays: number;
  customKeywords?: readonly string[];
}

/** The write input → the row's column values. */
export function subscriptionPolicyToColumns(policy: SubscriptionPolicyWrite): {
  must_contain: string;
  must_not_contain: string;
  episode_filter: string;
  use_regex: number;
  cooldown_days: number;
  custom_keywords: string;
} {
  return {
    must_contain: serializeTermList(policy.mustContain),
    must_not_contain: serializeTermList(policy.mustNotContain),
    episode_filter: policy.episodeFilter,
    use_regex: policy.useRegex ? 1 : 0,
    cooldown_days: policy.cooldownDays,
    custom_keywords: serializeTermList(policy.customKeywords ?? []),
  };
}

/** The policy a work has when nobody has configured one. */
export function emptyStoredPolicy(input: { accountId: string; titleKey: string; now: string }): StoredSubscriptionPolicy {
  return {
    ...EMPTY_POLICY,
    accountId: input.accountId,
    titleKey: input.titleKey,
    createdAt: input.now,
    updatedAt: input.now,
    lastTakenAt: null,
  };
}

/**
 * Round-trip a policy through the row shape. The test for losslessness: a policy the
 * user saved must come back byte-for-byte the same, or the next run filters on something
 * they never wrote. Trimming is the one intentional normalization (see serializeTermList).
 */
export function roundTripPolicy(policy: SubscriptionPolicyWrite): SubscriptionPolicyWrite {
  const columns = subscriptionPolicyToColumns(policy);
  return {
    mustContain: parseTermList(columns.must_contain, "must_contain"),
    mustNotContain: parseTermList(columns.must_not_contain, "must_not_contain"),
    episodeFilter: columns.episode_filter,
    useRegex: columns.use_regex === 1,
    cooldownDays: columns.cooldown_days,
    ...(policy.customKeywords !== undefined
      ? { customKeywords: parseTermList(columns.custom_keywords, "custom_keywords") }
      : {}),
  };
}
