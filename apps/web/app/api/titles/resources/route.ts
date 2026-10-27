import { connection, NextResponse, type NextRequest } from "next/server";
import {
  CooldownLimiter,
  TitleResourceCache,
  resolveTitleResources,
  buildTitleSearchKeywords,
  type ResourceCandidateView,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository, getWorkerResourceProvider } from "../../../../lib/workflow-runtime";

/**
 * POST /api/titles/resources — the user-triggered resource search (W2, batch 2).
 *
 * Read-only: this endpoint spends indexer/drive budget but never writes to a drive.
 * It is the first of the three new things the plan lists for W2; the other two
 * (candidate → import resolution, and the manual-import job carrier) are batch 3.
 *
 * Gates, in this order (the order is the design — see title-resource-resolver.ts):
 *   1. scope   — no resolvable account ⇒ 401, and the limiter is NOT touched
 *   2. cooldown — 60s per (account, title) ⇒ 429 + Retry-After
 *   3. TTL     — 30 min per (account, title) ⇒ same candidateIds, no re-search
 *
 * The title must be one THIS account tracks. `listTrackedSeasonStates(scope)` is
 * fail-closed, so "not in my scoped list" is the scope verdict — an untracked tmdbId
 * is invisible (404), not searchable. Without that check the endpoint would let any
 * caller probe resources for any title in the catalogue.
 *
 * The keyword ladder is built server-side from the title; the user never types one.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 30 minutes — how long a returned candidateId stays usable (plan §3.2). */
const RESOURCE_TTL_MS = 30 * 60 * 1000;
/** 60s — how soon the same title may be searched again (plan §3.2). */
const RESOURCE_COOLDOWN_MS = 60 * 1000;

/**
 * Module-level singletons: the whole point of the TTL and the cooldown is that they
 * span requests. Next.js may instantiate the module more than once across bundles,
 * but within a server process these are the shared instances.
 */
const resourceCache = new TitleResourceCache<ResourceCandidateView>({
  now: () => Date.now(),
  ttlMs: RESOURCE_TTL_MS,
  idOf: (view) => view.candidateId,
});
const resourceLimiter = new CooldownLimiter({ now: () => Date.now(), cooldownMs: RESOURCE_COOLDOWN_MS });

export async function POST(request: NextRequest) {
  await connection();

  // 1) Scope, fail-closed.
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  let tmdbId: number;
  try {
    const body = (await request.json()) as { tmdbId?: unknown };
    tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : Number.NaN;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400, headers: NO_STORE });
  }

  // 2) Scope verdict: the title must be tracked by THIS account.
  // ScopeArg 的 string 形态即 { accountId, connectedStorageId: null }——按账号取，
  // 跨所有 drive。这里要的是「这个账号追踪了这部片吗」，drive 归属不影响判定。
  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const title = states.map((state) => state.title).find((candidate) => candidate.tmdbId === tmdbId);
  if (!title) {
    // Fail closed: an untracked title is invisible, not searchable.
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }

  const keywords = buildTitleSearchKeywords(title).map((entry) => entry.keyword);

  const provider = await getWorkerResourceProvider();
  const result = await resolveTitleResources({
    accountId,
    titleId: String(tmdbId),
    keywords,
    search: ({ keyword }) => provider.search({ keyword }),
    cache: resourceCache,
    limiter: resourceLimiter,
    loadCachedCandidates: async () => [],
  });

  switch (result.kind) {
    case "unauthorized":
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    case "throttled":
      return NextResponse.json(
        { error: "too many requests", retryAfterMs: result.retryAfterMs },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) } },
      );
    case "error":
      // 502, not 500: the failure is upstream (indexer), not this request's fault.
      return NextResponse.json({ error: "search failed", detail: result.message }, { status: 502, headers: NO_STORE });
    case "ok":
      return NextResponse.json(
        { tmdbId, cached: result.cached, count: result.candidates.length, candidates: result.candidates },
        { headers: NO_STORE },
      );
  }
}
