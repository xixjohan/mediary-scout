import { connection, NextResponse, type NextRequest } from "next/server";
import {
  buildTitleSearchKeywords,
  previewPolicy,
  type PolicyResource,
  type SubscriptionPolicy,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkerResourceProvider, getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { resourceLimiter } from "../../resources/cache";

/**
 * POST /api/titles/subscription-policy/preview — 规则预览 (batch 5, plan §4.1).
 *
 * The plan asks for exactly this, and calls it "low cost, high value": before saving a
 * rule, run it against the CURRENT search results and tell the user "this rule hits 3,
 * excludes 7". A rule whose effect is invisible until the next patrol is a rule the user
 * cannot tune.
 *
 * ## The one invariant that makes the preview honest
 *
 * The preview calls the SAME `matchPolicy` the patrol's candidate filter calls (see
 * acquisition-v2/real-provider-adapter.ts). Not a reimplementation, not an approximation
 * — the same function on the same names. That is why the numbers are a promise rather
 * than an estimate, and why the pure test asserts `preview.matchedCount ===
 * resources.filter(matchPolicy).length` instead of a hard-coded number.
 *
 * ## Why this searches live instead of reading stored results
 *
 * A preview over stale results is a preview of the past. So it searches now, reusing the
 * resources route's cache + cooldown (the same singletons, so a preview right after a
 * search costs nothing) and reporting how many keywords it ran over: a preview over 1
 * keyword is a weaker statement than one over 5, and the user is entitled to know which
 * they got.
 *
 * What it does NOT do: it saves nothing. A preview is a read; saving is
 * `PUT /api/titles/subscription-policy`. Keeping them separate is what makes "preview"
 * safe to call while the user is still typing.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

type PreviewRequest = { tmdbId: number; seasonNumber: number | undefined; policy: SubscriptionPolicy };

/** Read the body without throwing — a non-JSON body is a 400, not a 500. */
async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Validate the whole body at once. Split out of POST for the complexity budget, and
 * because "which field was wrong" is one question the caller should not have to
 * re-derive from three separate checks.
 */
export function parsePreviewBody(value: unknown):
  | { ok: true; tmdbId: number; seasonNumber: number | undefined; policy: SubscriptionPolicy }
  | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "请求体不是 JSON" };
  }
  const body = value as Record<string, unknown>;
  const tmdbId = typeof body["tmdbId"] === "number" ? body["tmdbId"] : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId 必须是正整数" };
  }
  const rawSeason = body["seasonNumber"];
  const seasonNumber = rawSeason === undefined || rawSeason === null ? undefined : rawSeason;
  if (
    seasonNumber !== undefined &&
    (typeof seasonNumber !== "number" || !Number.isInteger(seasonNumber) || seasonNumber <= 0)
  ) {
    return { ok: false, error: "seasonNumber 必须是正整数" };
  }
  const policy = parsePreviewPolicy(body["policy"]);
  if (!policy.ok) return { ok: false, error: policy.error };
  const request: PreviewRequest = { tmdbId, seasonNumber, policy: policy.policy };
  return { ok: true, ...request };
}

/** The policy fields a browser may send. Anything else is a 400, not a guess. */
export function parsePreviewPolicy(value: unknown): { ok: true; policy: SubscriptionPolicy } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "policy 缺失或类型不对" };
  }
  const raw = value as Record<string, unknown>;
  const terms = (key: string): string[] => {
    const list = raw[key];
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error(`${key} 必须是数组`);
    for (const term of list) {
      if (typeof term !== "string") throw new Error(`${key} 里只能有字符串`);
    }
    return list as string[];
  };
  const episodeFilter = raw["episodeFilter"];
  if (episodeFilter !== undefined && typeof episodeFilter !== "string") {
    return { ok: false, error: "episodeFilter 必须是字符串" };
  }
  const cooldownDays = raw["cooldownDays"];
  if (
    cooldownDays !== undefined &&
    (typeof cooldownDays !== "number" || !Number.isInteger(cooldownDays) || cooldownDays < 0)
  ) {
    return { ok: false, error: "cooldownDays 必须是非负整数" };
  }
  try {
    return {
      ok: true,
      policy: {
        mustContain: terms("mustContain"),
        mustNotContain: terms("mustNotContain"),
        episodeFilter: episodeFilter ?? "",
        useRegex: raw["useRegex"] === true,
        cooldownDays: cooldownDays ?? 0,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "policy 无法解析" };
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  // 1) Scope, fail-closed. A preview reads search results, so it may not run unauthenticated.
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  // 2) Body.
  const parsed = parsePreviewBody(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  // 3) The title must be tracked by THIS account — same fail-closed rule as the resources
  //    route. An untracked title is invisible, not previewable.
  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const tracked = states.find((state) => state.title.tmdbId === parsed.tmdbId);
  if (!tracked) {
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }

  // 4) Search live, reusing the resources route's cache + cooldown singletons so a preview
  //    right after a search costs nothing (and is rate-limited the same way).
  const keywords = buildTitleSearchKeywords(tracked.title).map((entry) => entry.keyword);
  // Same cooldown as the resources route: a preview right after a search should hit the
  // cache, and a preview fired repeatedly must not walk around the limiter the user's
  // own search just paid. Keyed by account + title, so previewing one title never throttles another.
  const cooldownKey = `preview:${accountId}:title:${parsed.tmdbId}`;
  if (!resourceLimiter.tryAcquire(cooldownKey)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: NO_STORE });
  }
  const provider = await getWorkerResourceProvider();
  // Deduped by name: the same resource found under three keywords is still ONE resource.
  // Counting it three times would tell the user "this rule hits 6" when it hits 2 — the
  // exact preview lie this route exists to prevent.
  const byName = new Map<string, PolicyResource>();
  try {
    for (const keyword of keywords) {
      const snapshot = await provider.search({ keyword });
      for (const candidate of snapshot.candidates) {
        byName.set(candidate.title, { name: candidate.title });
      }
    }
  } catch (error) {
    // 502, not an empty preview: "0 matched" read as "your rule matches nothing" when the
    // truth is "we could not look" sends the user off to loosen a rule that was fine.
    resourceLimiter.reset(cooldownKey);
    return NextResponse.json(
      { error: "搜索失败，无法预览", detail: error instanceof Error ? error.message : String(error) },
      { status: 502, headers: NO_STORE },
    );
  }

  // 5) Preview — the same matcher the patrol uses.
  const resources = [...byName.values()];
  const preview = previewPolicy(parsed.policy, resources);

  return NextResponse.json(
    {
      ok: true,
      searchedKeywords: keywords.length,
      total: resources.length,
      matchedCount: preview.matchedCount,
      excludedCount: preview.excludedCount,
      // The names, not the URLs: a preview must show WHICH resources a rule touches, and a
      // browser has no business holding a drive link it did not ask for.
      matched: preview.matched.map((entry) => entry.name),
      excluded: preview.excluded.map((entry) => ({ name: entry.resource.name, reason: entry.reason })),
    },
    { status: 200, headers: NO_STORE },
  );
}
