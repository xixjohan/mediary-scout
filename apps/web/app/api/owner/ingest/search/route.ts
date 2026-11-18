import { connection, NextResponse, type NextRequest } from "next/server";
import {
  SEARCH_BACKEND_LABELS,
  SEARCH_BACKENDS,
  getStorageBrand,
  isRegisteredStorageProvider,
  normalizeSearchBackends,
  type SearchBackend,
} from "@media-track/workflow";
import { requireOwner } from "../../../../../lib/owner-guard";
import {
  getAccountConnectedStorages,
  getAccountScopedSettings,
  getWorkflowRepository,
  getWorkerResourceProvider,
  getAcquisitionFilterPreferences,
} from "../../../../../lib/workflow-runtime";
import { getHaisouApiKey, getProwlarrConfig } from "../../../../../lib/runtime/settings-readers";
import { getScopedStorageCredentials } from "../../../../../lib/media-scope";
import {
  searchOwnerIngestCandidates,
  type SearchBackendView,
} from "../../../../../features/storage-drives/application/owner-ingest-service";

/**
 * POST /api/owner/ingest/search —— 站长按关键字检索可投放资源。
 *
 * 与 `/api/titles/resources` 的分工：那一端从作品身份推导关键词并要求 tmdbId；
 * 这一端**只吃用户给的关键字**，不构造任何作品身份（作品绑定是可选的，发生在
 * 提交阶段）。
 *
 * 可选 `backends`：本次用哪几个搜索源（不传 = 账号已配置的全部）。选择只收窄
 * 本次检索，不改设置；品牌约束仍然优先（目标盘产不出磁力时 Prowlarr 会被跳过）。
 *
 * 门禁只有一道：`requireOwner`。不用 `storage:transfer` 的理由见 owner-guard.ts
 * ——成员本来就有那把钥匙，用权限点表达「只允许站长」等于没表达。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface ParsedSearchBody {
  keyword: string;
  storageId: string;
  backends: SearchBackend[];
  /** 请求里出现的未知后端名。非空时端点回 400——`normalizeSearchBackends`
   *  会静默丢弃它们，而空数组等于「全用」：静默丢弃会把「打错名字」变成
   *  「悄悄用了所有源」。 */
  unknownBackends: string[];
}

export function parseOwnerIngestSearchBody(value: unknown): { ok: true; body: ParsedSearchBody } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const record = value as Record<string, unknown>;
  const keyword = typeof record["keyword"] === "string" ? record["keyword"].trim() : "";
  const storageId = typeof record["storageId"] === "string" ? record["storageId"].trim() : "";
  const rawBackends = Array.isArray(record["backends"]) ? record["backends"] : [];
  if (keyword.length === 0) return { ok: false, error: "请输入检索关键词" };
  if (keyword.length > 64) return { ok: false, error: "关键词过长（最多 64 个字符）" };
  if (storageId.length === 0) return { ok: false, error: "请选择目标网盘" };
  const unknownBackends = rawBackends
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => (entry as string).trim())
    .filter((entry) => !(SEARCH_BACKENDS as readonly string[]).includes(entry));
  return {
    ok: true,
    body: { keyword, storageId, backends: normalizeSearchBackends(rawBackends), unknownBackends },
  };
}

/**
 * 该账号 + 该盘可选/可用的检索后端。
 *
 * `configured = false` 的后端仍然返回：UI 需要让用户看见「这台后端存在但没配置」，
 * 而不是凭空少一行。品牌约束（磁力不适用）直接不出现在列表里。
 */
export async function resolveSearchBackendViews(input: {
  settings: { getSetting(key: string): Promise<string | null> };
  provider: string;
}): Promise<SearchBackendView[]> {
  const kinds = isRegisteredStorageProvider(input.provider)
    ? getStorageBrand(input.provider).resourceProviderKinds
    : ["pansou-115", "prowlarr"];
  const prowlarrConfigured = await getProwlarrConfig(input.settings).then(
    (config) => Boolean(config.baseURL && config.apiKey),
    () => false,
  );
  const haisouConfigured = await getHaisouApiKey(input.settings).then(
    (key) => Boolean(key && key.trim()),
    () => false,
  );
  const supportsMagnet = kinds.includes("prowlarr") || kinds.includes("pansou-magnet");

  return SEARCH_BACKENDS.filter((backend) => backend !== "prowlarr" || supportsMagnet).map((backend) => ({
    backend,
    label: SEARCH_BACKEND_LABELS[backend],
    configured: backend === "pansou" ? true : backend === "prowlarr" ? prowlarrConfigured : haisouConfigured,
  }));
}

export async function POST(request: NextRequest) {
  await connection();

  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;
  const accountId = gate.accountId;

  let parsed: ReturnType<typeof parseOwnerIngestSearchBody>;
  try {
    parsed = parseOwnerIngestSearchBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const { keyword, storageId, backends, unknownBackends } = parsed.body;
  if (unknownBackends.length > 0) {
    return NextResponse.json(
      { error: `未知的检索后端：${unknownBackends.join(", ")}` },
      { status: 400, headers: NO_STORE },
    );
  }
  const creds = await getScopedStorageCredentials(storageId);
  if (!creds) {
    return NextResponse.json({ error: "未找到该网盘，请先在设置中连接" }, { status: 404, headers: NO_STORE });
  }
  if (creds.status !== "active") {
    return NextResponse.json({ error: "网盘授权已失效，请先重新连接后再检索" }, { status: 409, headers: NO_STORE });
  }

  const settings = getAccountScopedSettings(accountId);
  const views = await resolveSearchBackendViews({ settings, provider: creds.provider });
  // 选中的后端必须在「本盘可用」列表里；不在列表里的名字（拼错 / 该盘不支持）直接 400，
  // 而不是静默丢掉——静默丢掉会让用户以为选了 Prowlarr、实际只跑了盘搜。
  const unavailable = backends.filter((backend) => !views.some((view) => view.backend === backend));
  if (unavailable.length > 0) {
    return NextResponse.json(
      { error: `该网盘不支持这些检索后端：${unavailable.join(", ")}` },
      { status: 400, headers: NO_STORE },
    );
  }
  // 选了但「没配置」同样 400：装配层会静默跳过它，结果就是「选了却没用上」。
  const unconfigured = views.filter((view) => backends.includes(view.backend) && !view.configured);
  if (unconfigured.length > 0) {
    return NextResponse.json(
      { error: `这些检索后端尚未配置，请先在设置页完成配置：${unconfigured.map((view) => view.label).join("、")}` },
      { status: 409, headers: NO_STORE },
    );
  }

  const provider = await getWorkerResourceProvider(settings, creds.provider, accountId, { backends });
  const filterPreferences = await getAcquisitionFilterPreferences(settings);

  const outcome = await searchOwnerIngestCandidates({
    accountId,
    storageId,
    keyword,
    provider,
    repository: getWorkflowRepository(),
    backends,
    filterPreferences,
  });

  if (outcome.kind === "throttled") {
    return NextResponse.json(
      { error: "检索过于频繁，请稍后再试", retryAfterMs: outcome.retryAfterMs },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) },
      },
    );
  }
  if (outcome.kind === "error") {
    return NextResponse.json({ error: outcome.message }, { status: 502, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      searchRunId: outcome.result.searchRunId,
      keyword: outcome.result.keyword,
      cached: outcome.result.cached,
      count: outcome.result.candidates.length,
      backends: outcome.result.backends,
      // 只有标量事实跨边界：payload（分享链/磁力）永远留在服务端。
      candidates: outcome.result.candidates,
    },
    { headers: NO_STORE },
  );
}

/** 供 UI 在首屏拿到可选网盘列表 + 每块盘可用的检索后端。 */
export async function GET(request: NextRequest) {
  await connection();
  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;

  const storages = await getAccountConnectedStorages();
  const settings = getAccountScopedSettings(gate.accountId);
  const perStorage = Object.fromEntries(
    await Promise.all(
      storages.map(async (storage) => [
        storage.id,
        await resolveSearchBackendViews({ settings, provider: storage.provider }).catch(() => []),
      ]),
    ),
  );
  return NextResponse.json({ storages, backendsByStorage: perStorage }, { headers: NO_STORE });
}
