/**
 * Batch 5: the patrol's cost gate (plan §4.1 成本模型).
 *
 * The plan is explicit about the cost model: 国内网盘搜索没有可靠增量游标, so this project
 * can only do 「周期全量重搜 + 指纹去重 + 冷却」, and the real cost is
 * `监控季数 × 每日搜索次数 × 单次延迟`. Two guards follow from that, and BOTH were pure
 * functions with tests but **no callers** until this module wired them into the sweep:
 *
 *   1. **monitored-season budget** (`checkMonitoredSeasonBudget`) — a cap so a season
 *      count nobody configured cannot quietly drag the patrol down. Default conservative
 *      (50), over-limit says so out loud instead of silently slowing every sweep.
 *   2. **per-work cooldown** (`withinCooldown`) — qBittorrent's "Ignore subsequent
 *      matches for". A work whose policy matched something N days ago is not searched
 *      again until the window passes.
 *
 * ## Why the decision is a pure function
 *
 * It decides which works get searched today, and it must be testable at boundaries
 * (exactly N days, an unreadable timestamp, a work with no policy). Inlined into the
 * sweep, only the logging would be testable — and the logging is not the part that
 * spends the user's rate-limit budget.
 *
 * ## The one ordering decision
 *
 * The budget is checked BEFORE the cooldown, and an over-budget sweep still runs the
 * works that are inside it. Skipping everything would stop every subscription; the plan
 * says 「超限明确告知而非默默拖垮巡检」 — tell, and keep going within the cap.
 */

import {
  checkMonitoredSeasonBudget,
  type MonitoredSeasonBudget,
} from "./monitor-budget.js";
import {
  withinCooldown,
  type SubscriptionPolicy,
} from "./subscription-policy.js";
import type { StoredSubscriptionPolicy } from "./subscription-policy-store.js";

/** One work the sweep is considering. */
export interface PatrolCandidate {
  accountId: string;
  /** The title's identity as `subscription_policies.title_key` stores it. */
  titleKey: string;
  /** For the message: which show was skipped, in the user's words. */
  titleName: string;
}

/**
 * Why a candidate did not get swept. Only `cooldown` exists today: no policy means
 * "sweep normally" (the strategy layer is an opt-in filter, not a gate), so there is
 * nothing to report. A member with no producer is a lie about what the code does —
 * it reads like a branch that exists somewhere.
 */
export type PatrolSkipReason = "cooldown";

export interface PatrolSkip {
  /** Which account's cooldown this was. A title is shared across accounts, so the
   *  key is (account, title) — never the title alone. */
  accountId: string;
  titleKey: string;
  titleName: string;
  reason: PatrolSkipReason;
  /** Human-readable, for the sweep's log line. */
  detail: string;
}

/** The (account, title) key a cooldown is scoped to. Exported so the sweep's filter
 *  and the decision cannot disagree about what "the same work" means. */
export function patrolSkipKey(entry: { accountId: string; titleKey: string }): string {
  return `${entry.accountId}\u0000${entry.titleKey}`;
}

export interface PatrolScopeDecision {
  /** Works to search this sweep. */
  included: PatrolCandidate[];
  /** Works deliberately left out, with why. */
  skipped: PatrolSkip[];
  /** The budget verdict for the whole sweep. Non-null only when over the cap. */
  overBudget: { limit: number; overBy: number; message: string } | null;
}

/** A policy as the gate reads it: `null` means this work has no rule configured. */
export type PolicyLookup = (candidate: PatrolCandidate) => Promise<StoredSubscriptionPolicy | null>;

/**
 * Decide what this sweep searches.
 *
 * A work with **no policy** is included, not skipped: an unconfigured work is the common
 * case (the user tracks a show and has not written a rule yet), and skipping it would
 * mean the strategy layer silently turns off subscriptions for everyone who has not
 * opted in. The policy is a filter on top of the patrol, not a gate in front of it.
 */
export async function planPatrolScope(input: {
  candidates: readonly PatrolCandidate[];
  lookupPolicy: PolicyLookup;
  /** Configured cap; unset/invalid falls back to the conservative default. */
  configuredMaxSeasons?: number | string | null;
  /** Patrols per day, for the cost estimate in the over-budget message. */
  searchesPerDay?: number;
  now: string;
}): Promise<PatrolScopeDecision> {
  const budget = checkMonitoredSeasonBudget({
    count: input.candidates.length,
    ...(input.configuredMaxSeasons === undefined ? {} : { configured: input.configuredMaxSeasons }),
    ...(input.searchesPerDay === undefined ? {} : { searchesPerDay: input.searchesPerDay }),
  });

  const included: PatrolCandidate[] = [];
  const skipped: PatrolSkip[] = [];

  for (const candidate of input.candidates) {
    const policy = await input.lookupPolicy(candidate);
    // No policy ⇒ patrol as before. The strategy layer is opt-in.
    if (policy === null) {
      included.push(candidate);
      continue;
    }
    if (withinCooldown({ policy, lastTakenAt: policy.lastTakenAt, now: input.now })) {
      const days = policy.cooldownDays;
      skipped.push({
        accountId: candidate.accountId,
        titleKey: candidate.titleKey,
        titleName: candidate.titleName,
        reason: "cooldown",
        detail: `冷却中（${days} 天内已匹配过，${policy.lastTakenAt ?? "?"}）`,
      });
      continue;
    }
    included.push(candidate);
  }

  return {
    included,
    skipped,
    overBudget: budget.withinBudget
      ? null
      : { limit: budget.limit, overBy: budget.overBy, message: budget.message },
  };
}

/** The sweep's log line for an over-budget sweep. Says what to do, not just that it is over. */
export function overBudgetLogLine(decision: PatrolScopeDecision): string | null {
  if (decision.overBudget === null) return null;
  return `[patrol] ${decision.overBudget.message} 本次仍巡检上限内的 ${decision.included.length} 部。`;
}

/** The sweep's log line for the works it left out this round. */
export function cooldownLogLine(skipped: readonly PatrolSkip[]): string | null {
  const cooling = skipped.filter((entry) => entry.reason === "cooldown");
  if (cooling.length === 0) return null;
  const names = cooling.map((entry) => `${entry.titleName}（${entry.detail}）`).join("、");
  return `[patrol] 冷却中，跳过 ${cooling.length} 部：${names}`;
}

/** Exported for the gate's own tests: the policy shape the cooldown reads. */
export type { SubscriptionPolicy, StoredSubscriptionPolicy, MonitoredSeasonBudget };
