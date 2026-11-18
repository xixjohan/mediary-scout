import { connection, NextResponse, type NextRequest } from "next/server";
import {
  buildTitleSearchKeywords,
  parseEpisodeFilter,
  previewPolicy,
  resolveTitleResources,
  type MediaTitle,
  titleIdentityFrom,
  type PolicyResource,
  type SubscriptionPolicy,
} from "@media-track/workflow";
import { requirePermission } from "../../../../../lib/auth-chain";
import {
  getAccountScopedSettings,
  getAcquisitionFilterPreferences,
  getWorkerResourceProvider,
  getWorkflowRepository,
  movieTargetFromTmdbId,
} from "../../../../../lib/workflow-runtime";
import { seriesTargetFor } from "../../../../../lib/title-hub";
import { parseSeasonEpisodeRangesBody } from "../../../../../lib/subscription-policy-season-ranges";
import { parseSubtitlePreference, parseSubscriptionPriorityGroups } from "../../../../../lib/subscription-policy-validation";
import { resourceCache, resourceLimiter } from "../../resources/cache";
import { resolvePreviewDriveProvider } from "./drive-provider";

/**
 * POST /api/titles/subscription-policy/preview — 规则预览 (batch 5, plan §4.1)。
 *
 * 不变的核心承诺：预览与巡检跑**同一个** `matchPolicy`，所以「命中 N 个」是承诺
 * 而不是估算。
 *
 * 这次改造解决的是另外三件事，全部复用资源搜索已有的实现：
 *
 *  1. **不再串行逐关键词搜索**。以前这里是手写 `for … await provider.search`，
 *     而资源面板走 `resolveTitleResources` 的 `Promise.all` —— 同一检索在两个入口
 *     差一个数量级。现在两边共用同一条取数路径（并发 + 去重 + 排毒）。
 *  2. **不再绕过缓存**。预览此前只借限流器、不读 30 分钟 TTL 缓存，于是刚在详情页
 *     搜过的片，预览还要重付一次全量搜索。现在与资源路由同一语义：缓存命中直接
 *     复用，且**不扣冷却**。
 *  3. **预览的承诺补齐**。`seasonEpisodeRanges` / `customKeywords` / `subtitlePreference`
 *     此前根本没被解析，预览对它们的承诺是空的；现在它们进入同一个匹配器。
 *
 * `?stream=1` 时按 NDJSON 逐关键词推进度；无 stream 时仍一次性返回 JSON。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 一次预览的硬上限：再慢也不让请求挂在那里。 */
const PREVIEW_TIMEOUT_MS = 45_000;

type PreviewRequest = {
  tmdbId: number;
  seasonNumbers: number[];
  mediaType: "movie" | "tv" | "anime" | undefined;
  policy: SubscriptionPolicy;
  refresh: boolean;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

type PreviewRunOutcome =
  | { kind: "ok"; cached: boolean; sourceHealth?: unknown; preview: ReturnType<typeof previewPolicy> }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "error"; message: string };

type ProgressEvent = { done: number; total: number; currentKeyword: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMediaType(value: unknown): ParseResult<PreviewRequest["mediaType"]> {
  if (value === undefined || value === "movie" || value === "tv" || value === "anime") {
    return { ok: true, value };
  }
  return { ok: false, error: "mediaType 必须是 movie、tv 或 anime" };
}

function parseSeasonNumbers(body: Record<string, unknown>): ParseResult<number[]> {
  const values = body["seasonNumbers"];
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length > 100) {
      return { ok: false, error: "seasonNumbers 必须是最多 100 项的季号数组" };
    }
    if (!values.every((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      return { ok: false, error: "seasonNumbers 只能包含非负整数" };
    }
    return { ok: true, value: [...new Set(values)] };
  }

  const seasonNumber = body["seasonNumber"];
  if (seasonNumber === undefined || seasonNumber === null) return { ok: true, value: [] };
  if (typeof seasonNumber !== "number" || !Number.isInteger(seasonNumber) || seasonNumber <= 0) {
    return { ok: false, error: "seasonNumber 必须是正整数" };
  }
  return { ok: true, value: [seasonNumber] };
}

async function resolvePreviewTitle(accountId: string, request: PreviewRequest) {
  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const tracked = states.find((state) =>
    state.title.tmdbId === request.tmdbId &&
    (request.mediaType === undefined || (request.mediaType === "movie" ? state.title.type === "movie" : state.title.type !== "movie")),
  );
  if (tracked) return tracked.title;
  if (request.mediaType === "movie") return (await movieTargetFromTmdbId(request.tmdbId))?.title ?? null;
  if (request.mediaType === "tv" || request.mediaType === "anime") {
    return (await seriesTargetFor(request.tmdbId))?.title ?? null;
  }
  return null;
}

function previewKeywords(title: MediaTitle, request: PreviewRequest): string[] {
  const options = request.seasonNumbers.length > 0
    ? request.seasonNumbers.flatMap((seasonNumber) =>
        buildTitleSearchKeywords(title, { seasonNumber, customKeywords: request.policy.customKeywords }),
      )
    : buildTitleSearchKeywords(title, { customKeywords: request.policy.customKeywords });
  return [...new Set(options.map((entry) => entry.keyword))];
}

/**
 * 标题里能读出的集号。
 *
 * 归档时 `PolicyResource.episodeCode` 由适配器传入；预览只有标题，所以这里按同一
 * 形状解析一次，让 `seasonEpisodeRanges` 在预览与执行中得到同一个答案。
 */
/** 目标作品 → 身份闸门输入（片名 / 原名 / 别名 / 年份 / tmdb id）。 */
export function identityOf(title: MediaTitle) {
  return titleIdentityFrom({
    tmdbId: title.tmdbId,
    year: title.year,
    title: title.title,
    originalTitle: title.originalTitle,
    aliases: title.aliases,
  });
}

export function policyResourceFromTitle(name: string): PolicyResource {
  const match = /[Ss](\d{1,2})[Ee](\d{1,4})/.exec(name);
  return match?.[1] && match[2]
    ? { name, episodeCode: `S${match[1].padStart(2, "0")}E${match[2].padStart(2, "0")}` }
    : { name };
}

/** Read the body without throwing — a non-JSON body is a 400, not a 500. */
async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Validate the whole body at once: "which field was wrong" is one question the caller
 * should not have to re-derive from separate checks.
 */
export function parsePreviewBody(value: unknown):
  | ({ ok: true } & PreviewRequest)
  | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "请求体不是 JSON" };
  }
  const body = value;
  const tmdbId = typeof body["tmdbId"] === "number" ? body["tmdbId"] : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId 必须是正整数" };
  }
  const mediaType = parseMediaType(body["mediaType"]);
  if (!mediaType.ok) return mediaType;
  const seasons = parseSeasonNumbers(body);
  if (!seasons.ok) return seasons;
  const policy = parsePreviewPolicy(body["policy"]);
  if (!policy.ok) return { ok: false, error: policy.error };
  return {
    ok: true,
    tmdbId,
    seasonNumbers: seasons.value,
    mediaType: mediaType.value,
    policy: policy.policy,
    refresh: body["refresh"] === true,
  };
}

/** The policy fields a browser may send. Anything else is a 400, not a guess. */
export function parsePreviewPolicy(value: unknown): { ok: true; policy: SubscriptionPolicy } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "policy 缺失或类型不对" };
  }
  const raw = value as Record<string, unknown>;
  const episode = parsePreviewEpisodeFilter(raw["episodeFilter"]);
  if (!episode.ok) return episode;
  const cooldown = parsePreviewCooldown(raw["cooldownDays"]);
  if (!cooldown.ok) return cooldown;
  const groupsResult = parseSubscriptionPriorityGroups(raw["priorityGroups"]);
  if (!groupsResult.ok) return groupsResult;
  const rangesResult = parseSeasonEpisodeRangesBody(raw["seasonEpisodeRanges"]);
  if (!rangesResult.ok) return rangesResult;
  const subtitleResult = parseSubtitlePreference(raw["subtitlePreference"]);
  if (!subtitleResult.ok) return subtitleResult;
  const termLists = parsePreviewTermLists(raw);
  if (!termLists.ok) return termLists;
  return {
    ok: true,
    policy: {
      mustContain: termLists.mustContain,
      mustNotContain: termLists.mustNotContain,
      customKeywords: termLists.customKeywords,
      episodeFilter: episode.value,
      useRegex: raw["useRegex"] === true,
      cooldownDays: cooldown.value,
      priorityGroups: groupsResult.priorityGroups,
      seasonEpisodeRanges: rangesResult.ranges,
      ...(subtitleResult.subtitlePreference ? { subtitlePreference: subtitleResult.subtitlePreference } : {}),
    },
  };
}

/** 看不懂的 filter 会排除一切，所以预览也拒绝它（与保存路径同一条规则）。 */
function parsePreviewEpisodeFilter(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value !== undefined && typeof value !== "string") return { ok: false, error: "episodeFilter 必须是字符串" };
  const filter = (value as string | undefined) ?? "";
  if (parseEpisodeFilter(filter) === null) {
    return { ok: false, error: "episodeFilter 看不懂：形如 S01-S03、E01-E10、S02E05，用分号隔开" };
  }
  return { ok: true, value: filter };
}

function parsePreviewCooldown(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: "cooldownDays 必须是非负整数" };
  }
  return { ok: true, value };
}

function parsePreviewTermLists(raw: Record<string, unknown>):
  | { ok: true; mustContain: string[]; mustNotContain: string[]; customKeywords: string[] }
  | { ok: false; error: string } {
  const read = (key: string): string[] => {
    const list = raw[key];
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error(`${key} 必须是数组`);
    for (const term of list) {
      if (typeof term !== "string") throw new Error(`${key} 里只能有字符串`);
    }
    return list as string[];
  };
  try {
    return { ok: true, mustContain: read("mustContain"), mustNotContain: read("mustNotContain"), customKeywords: read("customKeywords") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "policy 无法解析" };
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  // 1) Scope, fail-closed. A preview reads search results, so it may not run unauthenticated.
  const gate = await requirePermission(request, "media:subscribe");
  if (gate instanceof Response) return gate;
  const accountId = gate.accountId;

  // 2) Body.
  const parsed = parsePreviewBody(await readJson(request));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  // 3) Resolve a tracked title first, then fall back to the catalog for the creation flow.
  const title = await resolvePreviewTitle(accountId, parsed);
  if (!title) {
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }

  // 4) Fetch through the SAME path as /api/titles/resources (parallel + cache + cooldown + filter).
  const keywords = previewKeywords(title, parsed);
  const settings = getAccountScopedSettings(accountId);
  const filterPreferences = await getAcquisitionFilterPreferences(settings);
  const provider = await getWorkerResourceProvider(settings, await resolvePreviewDriveProvider(accountId), accountId);

  const runPreview = async (onProgress?: (event: ProgressEvent) => void): Promise<PreviewRunOutcome> => {
    const result = await withTimeout(
      resolveTitleResources({
        accountId,
        titleId: String(parsed.tmdbId),
        keywords,
        search: ({ keyword }) => provider.search({ keyword }),
        cache: resourceCache,
        limiter: resourceLimiter,
        loadCachedCandidates: async () => [],
        filterPreferences,
        // 「重新搜索」是一次显式刷新：用独立缓存键，仍然受同一个限流器约束。
        ...(parsed.refresh ? { cacheKeySuffix: `refresh:${Math.floor(Date.now() / 60_000)}` } : {}),
        ...(onProgress ? { onChunk: (event) => onProgress(event.progress) } : {}),
      }),
      PREVIEW_TIMEOUT_MS,
    );
    if (result.kind === "throttled") return { kind: "throttled", retryAfterMs: result.retryAfterMs };
    if (result.kind === "unauthorized") return { kind: "error", message: "unauthorized" };
    if (result.kind === "error") return { kind: "error", message: result.message };
    // 按展示名去重：资源取数按 candidateId 去重，而同一份资源换了关键词就可能拿到
    // 不同的 id。预览数的是「用户眼里的资源」，同名只算一个——否则「命中 24 个」里
    // 一半是重复名字，数字就不再是承诺。
    const resources: PolicyResource[] = [];
    const seen = new Set<string>();
    for (const candidate of result.candidates) {
      const key = candidate.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(policyResourceFromTitle(candidate.title));
    }
    return {
      kind: "ok",
      cached: result.cached,
      ...(result.sourceHealth ? { sourceHealth: result.sourceHealth } : {}),
      // 身份闸门：预览的「命中」必须只算这部作品的资源。title 早在 resolvePreviewTitle
      // 就拿到了，之前只把名字喂给匹配器 —— 于是只写 `1080p` 的规则会把别家的 1080p
      // 全算成命中（2026-11-17 事故）。
      preview: previewPolicy(parsed.policy, resources, { identity: identityOf(title) }),
    };
  };

  if (isStreamRequested(request)) {
    return createPreviewNdjsonStream(runPreview, { title, keywords: keywords.length, parsed });
  }

  let outcome: PreviewRunOutcome;
  try {
    outcome = await runPreview();
  } catch (error) {
    // 502, not an empty preview: "0 matched" read as "your rule matches nothing" when the
    // truth is "we could not look" sends the user off to loosen a rule that was fine.
    const timeout = isTimeout(error);
    return NextResponse.json(
      { error: timeout ? "检索超时，规则本身未保存" : "搜索失败，无法预览", detail: error instanceof Error ? error.message : String(error) },
      { status: timeout ? 504 : 502, headers: NO_STORE },
    );
  }
  if (outcome.kind === "throttled") {
    return NextResponse.json(
      { error: "预览太频繁，稍后再试", retryAfterMs: outcome.retryAfterMs },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) } },
    );
  }
  if (outcome.kind === "error") {
    return NextResponse.json({ error: "搜索失败，无法预览", detail: outcome.message }, { status: 502, headers: NO_STORE });
  }
  return NextResponse.json(buildPreviewPayload(outcome, { title, keywords: keywords.length, parsed }), { status: 200, headers: NO_STORE });
}

/** 预览响应体：只回名字，不回直链 —— 浏览器没理由持有它没要过的链接。 */
export function buildPreviewPayload(
  outcome: Extract<PreviewRunOutcome, { kind: "ok" }>,
  context: { title: MediaTitle; keywords: number; parsed: PreviewRequest },
) {
  return {
    ok: true,
    searchedKeywords: context.keywords,
    total: outcome.preview.matched.length + outcome.preview.excluded.length,
    matchedCount: outcome.preview.matchedCount,
    excludedCount: outcome.preview.excludedCount,
    matchedWithSubtitleCount: outcome.preview.matchedWithSubtitleCount,
    matchedPackCount: outcome.preview.matchedPackCount,
    excludedByReason: outcome.preview.excludedByReason,
    cached: outcome.cached,
    matched: outcome.preview.matched.map((entry) => entry.name),
    excluded: outcome.preview.excluded.map((entry) => ({ name: entry.resource.name, reason: entry.reason })),
    ...(outcome.sourceHealth ? { sourceHealth: outcome.sourceHealth } : {}),
    ...(context.title.type === "movie" && context.title.releaseDate ? { releaseDate: context.title.releaseDate } : {}),
    ...(context.parsed.seasonNumbers.length > 0 ? { seasonNumbers: context.parsed.seasonNumbers } : {}),
  };
}

function createPreviewNdjsonStream(
  runPreview: (onProgress: (event: ProgressEvent) => void) => Promise<PreviewRunOutcome>,
  context: { title: MediaTitle; keywords: number; parsed: PreviewRequest },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      try {
        const outcome = await runPreview((progress) => send({ type: "progress", progress }));
        if (outcome.kind === "ok") {
          send({ type: "done", ...buildPreviewPayload(outcome, context) });
        } else if (outcome.kind === "throttled") {
          send({ type: "throttled", retryAfterMs: outcome.retryAfterMs });
        } else {
          send({ type: "error", message: outcome.message });
        }
      } catch (error) {
        send({ type: "error", message: isTimeout(error) ? "检索超时，规则本身未保存" : "搜索失败，无法预览" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isStreamRequested(request: NextRequest): boolean {
  if (request.nextUrl.searchParams.get("stream") === "1") return true;
  const accept = request.headers.get("accept");
  return Boolean(accept && accept.includes("application/x-ndjson"));
}

class PreviewTimeoutError extends Error {
  constructor() {
    super("检索超时，规则本身未保存");
    this.name = "PreviewTimeoutError";
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof PreviewTimeoutError;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PreviewTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
