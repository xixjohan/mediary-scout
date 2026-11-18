import { connection, NextResponse, type NextRequest } from "next/server";
import {
  defaultShareInspectorRegistry,
  type ResourceCandidate,
  type ResourceInspectionResult,
} from "@media-track/workflow";
import { requireOwner } from "../../../../../lib/owner-guard";
import { getScopedStorageCredentials } from "../../../../../lib/media-scope";
import { getWorkflowRepository } from "../../../../../composition/runtime-container";
import { loadOwnerIngestSnapshot } from "../../../../../features/storage-drives/application/owner-ingest-service";
import { buildShareProbesForCredentials } from "../../../../../features/storage-drives/application/share-probe-service";

/**
 * POST /api/owner/ingest/inspect —— 站长投放面板的「这条分享还活着吗」。
 *
 * 为什么不是复用 `/api/titles/resources/inspect`：那一端要求 tmdbId（作品身份），
 * 且按 `resourceSearchRunId(snapshotId)` 取快照。投放的检索记录挂在
 * `owner_ingest_search_*` 上，两者的 run id 推导不同——硬接会让投放面板永远
 * 404。这里复用同一套**探测适配器注册表**，只把「快照从哪取」换成投放侧。
 *
 * 探测口径（三条都重要）：
 *  - **登录态优先**：选中的目标网盘就是转存会用的账号，先用它的品牌探针
 *    （123/天翼/光鸭自己列分享根目录）；没有该品牌探针时退回匿名适配器
 *    （115/夸克/UC 有匿名分享详情接口）。
 *  - **绝不谎报**：需要登录态但没凭据时，适配器给 unknown，前端显示「未校验」，
 *    不显示「有效」。
 *  - **批量、有界**：一次最多 N 条，并发限 2，避免把网盘/搜索源打成风控对象。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** 单次请求最多探测的候选数。面板一次勾选通常 1–20 条。 */
const MAX_INSPECT_CANDIDATES = 12;
/** 同时进行的探测数：分享详情接口对突发请求很敏感（115 尤其）。 */
const INSPECT_CONCURRENCY = 2;

export function parseOwnerIngestInspectBody(value: unknown):
  | { ok: true; body: { storageId: string; searchRunId: string; candidateIds: string[] } }
  | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const record = value as Record<string, unknown>;
  const storageId = typeof record["storageId"] === "string" ? record["storageId"].trim() : "";
  const searchRunId = typeof record["searchRunId"] === "string" ? record["searchRunId"].trim() : "";
  const raw = Array.isArray(record["candidateIds"]) ? record["candidateIds"] : [];
  const candidateIds = raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!storageId) return { ok: false, error: "请选择目标网盘" };
  if (!searchRunId) return { ok: false, error: "缺少检索标识，请重新检索" };
  if (candidateIds.length === 0) return { ok: false, error: "请至少选择一个候选资源" };
  return {
    ok: true,
    body: { storageId, searchRunId, candidateIds: candidateIds.slice(0, MAX_INSPECT_CANDIDATES) },
  };
}

/** 并发有界的批量探测，结果按输入顺序返回。 */
async function inspectBounded(input: {
  candidates: readonly ResourceCandidate[];
  probe: (candidate: ResourceCandidate) => Promise<ResourceInspectionResult>;
}): Promise<ResourceInspectionResult[]> {
  const results = new Array<ResourceInspectionResult>(input.candidates.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(INSPECT_CONCURRENCY, input.candidates.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const candidate = input.candidates[index];
      if (!candidate) return;
      results[index] = await input.probe(candidate);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: NextRequest) {
  await connection();

  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;
  const accountId = gate.accountId;

  let parsed: ReturnType<typeof parseOwnerIngestInspectBody>;
  try {
    parsed = parseOwnerIngestInspectBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const { storageId, searchRunId, candidateIds } = parsed.body;
  const creds = await getScopedStorageCredentials(storageId);
  if (!creds) {
    return NextResponse.json({ error: "未找到该网盘，请先在设置中连接" }, { status: 404, headers: NO_STORE });
  }

  const snapshot = await loadOwnerIngestSnapshot({
    repository: getWorkflowRepository(),
    accountId,
    connectedStorageId: creds.id,
    searchRunId,
  });
  if (snapshot === null) {
    return NextResponse.json({ error: "检索记录不存在或已过期，请重新检索" }, { status: 404, headers: NO_STORE });
  }

  const candidates = candidateIds
    .map((id) => snapshot.candidates.find((entry) => entry.id === id))
    .filter((candidate): candidate is ResourceCandidate => candidate !== undefined);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "候选不在该检索记录中" }, { status: 404, headers: NO_STORE });
  }

  // 目标盘自己的登录态探测优先；默认注册表已覆盖 115/夸克/UC 的匿名探测。
  const registry = withCredentialedProbes(creds.provider, buildShareProbesForCredentials(creds));

  const results = await inspectBounded({
    candidates,
    probe: (candidate) => registry.inspect(candidate),
  });

  return NextResponse.json({ inspections: results }, { headers: NO_STORE });
}

/** 把该盘的登录态探针临时套在默认注册表外面（未覆盖的类型继续走默认适配器）。
 *
 *  为什么不改全局单例：默认注册表是进程级、跨账号共享的，把某块盘的凭据
 *  探针注册进去会让别的账号的请求也用上它。这里用一个**请求内的包装**
 *  ——缓存/单飞都在已选中的适配器内部，天然按 (账号, 盘) 隔离。
 */
function withCredentialedProbes(
  provider: string,
  probes: ReturnType<typeof buildShareProbesForCredentials>,
) {
  return {
    async inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult> {
      const probe = probes.find((entry) => entry.supportedTypes.includes(candidate.type));
      if (probe) return probe.inspect(candidate);
      try {
        // 默认注册表的缓存是进程级的、以 candidateId 为键——投放的候选 id 里
        // 已经带了检索 run，不会跨检索串味；但这里仍走 bypass 以免一条过期
        // 的 10 分钟缓存让站长看不到「刚刚复活」的链接。
        return await defaultShareInspectorRegistry.inspect(candidate, { bypassCache: true });
      } catch (error) {
        return {
          candidateId: candidate.id,
          status: "unknown",
          message: error instanceof Error ? error.message : `网盘【${provider}】探测失败`,
          probedAt: new Date().toISOString(),
        };
      }
    },
  };
}
