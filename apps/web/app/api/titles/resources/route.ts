import { connection, NextResponse, type NextRequest } from "next/server";
import {
  resolveTitleResources,
  buildTitleSearchKeywords,
  buildResourceSearchRun,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository, getWorkerResourceProvider } from "../../../../lib/workflow-runtime";
import { resourceCache, resourceLimiter } from "./cache";

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
  const tracked = states.find((state) => state.title.tmdbId === tmdbId);
  if (!tracked) {
    // Fail closed: an untracked title is invisible, not searchable.
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }
  const title = tracked.title;

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
      // Persist the merged snapshot as an invisible `resource_search` run (batch 3).
      // This is the only reason the later import can recover a candidate's payload
      // from the DB instead of the process-local CandidateRegistry. On a cache hit
      // `result.snapshot` is null — that miss already persisted it.
      //
      // A persistence failure must NOT fail the search: the user asked for resources
      // and got them. The only consequence is that a later import of one of these
      // candidates is refused with 「请重新查询」, which is recoverable; failing the
      // search here would hide results the user is entitled to see.
      if (result.snapshot !== null) {
        try {
          await getWorkflowRepository().saveWorkflowRunSnapshot(
            buildResourceSearchRun({
              snapshot: result.snapshot,
              title,
              season: tracked.season,
              accountId,
              connectedStorageId: tracked.connectedStorageId,
              now: result.snapshot.createdAt,
            }),
          );
        } catch (error) {
          console.error("[titles/resources] snapshot persist failed", error);
        }
      }
      return NextResponse.json(
        {
          tmdbId,
          cached: result.cached,
          count: result.candidates.length,
          candidates: result.candidates,
          // The opaque handle the import endpoint needs. Not sensitive: it encodes the
          // accountId and tmdbId the caller already has. Without it the client could
          // only send a candidateId, and the server would have to guess which of the
          // user's searches it came from.
          ...(result.snapshot === null ? {} : { snapshotId: result.snapshot.id }),
        },
        { headers: NO_STORE },
      );
  }
}
