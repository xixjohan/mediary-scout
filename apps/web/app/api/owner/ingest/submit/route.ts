import { connection, NextResponse, type NextRequest } from "next/server";
import {
  createDriveFileManager,
  getStorageBrand,
  isRegisteredStorageProvider,
  movieAnchorSeason,
  queueOwnerIngest,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";
import { requireOwner } from "../../../../../lib/owner-guard";
import { getScopedStorageCredentials } from "../../../../../lib/media-scope";
import { getWorkflowRepository } from "../../../../../composition/runtime-container";
import { loadOwnerIngestSnapshot } from "../../../../../features/storage-drives/application/owner-ingest-service";

/**
 * POST /api/owner/ingest/submit —— 站长把选中的候选投放到指定网盘目录。
 *
 * 三步，每步都可独立失败且给出可区分的错误：
 *  1. **取回检索记录**：候选 payload 只在库里（从不经过 HTTP）；检索记录不存在 /
 *     不属于这块盘 → 404。
 *  2. **目标目录校验**：站长可以投放到**影视库之外的任意目录**，但只校验两件
 *     与「能不能放」无关的事——目标存在（否则 115 会把过期 cid 静默解析到盘根）
 *     以及目标不是网盘账号根（往根投放会污染根目录，且 before/after 落盘对比要
 *     枚举整盘）。失败给 422，绝不把它排队成一个注定失败的 run。
 *  3. **排队**：转存是慢操作，不能在 HTTP 里等。`queueOwnerIngest` 复核候选成员与
 *     30 分钟窗口后写入一个 `owner_ingest` run；worker 会在下一次 drain 时执行。
 *     写入范围的裁决点在 worker：它只把本 run 的这一个目标目录授权给执行器
 *     （`StorageExecutor.authorizeWriteTarget`），其余目录照旧受各自写入范围约束。
 *
 * 可选「绑定作品」：给了 tmdbId 就用真实作品身份（落盘后触发 STRM/媒体服务器
 * 联动）；不给就用合成标题（纯投放，不进入订阅语义）。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface OwnerIngestSubmitItem {
  candidateId: string;
}

export interface ParsedSubmitBody {
  storageId: string;
  searchRunId: string;
  directoryId: string;
  displayPath: string;
  tmdbId?: number | undefined;
  mediaType?: "movie" | "tv" | "anime" | undefined;
  seasonNumber?: number | undefined;
  candidates: string[];
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readMediaType(record: Record<string, unknown>): "movie" | "tv" | "anime" | undefined {
  const value = record["mediaType"];
  return value === "movie" || value === "tv" || value === "anime" ? value : undefined;
}

export function parseOwnerIngestSubmitBody(value: unknown): { ok: true; body: ParsedSubmitBody } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "invalid body" };
  const record = value as Record<string, unknown>;
  const storageId = readString(record, "storageId");
  const searchRunId = readString(record, "searchRunId");
  const directoryId = readString(record, "directoryId");
  const displayPath = readString(record, "displayPath");
  const rawCandidates = Array.isArray(record["candidateIds"]) ? record["candidateIds"] : [];
  const candidates = rawCandidates.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!storageId) return { ok: false, error: "请选择目标网盘" };
  if (!searchRunId) return { ok: false, error: "缺少检索标识，请重新检索" };
  if (!directoryId) return { ok: false, error: "请选择入库目录" };
  if (candidates.length === 0) return { ok: false, error: "请至少选择一个候选资源" };

  const tmdbId = readPositiveInt(record, "tmdbId");
  const mediaType = readMediaType(record);
  const seasonNumber = readPositiveInt(record, "seasonNumber");

  return {
    ok: true,
    body: {
      storageId,
      searchRunId,
      directoryId,
      displayPath,
      ...(tmdbId === undefined ? {} : { tmdbId }),
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(seasonNumber === undefined ? {} : { seasonNumber }),
      candidates,
    },
  };
}

/**
 * 站长投放的目标目录校验：**只管「能不能放进去」，不管「在不在影视库」**。
 *
 * 两条硬约束，都是「早失败好过排队后失败」：
 *  1. 目标不能是网盘账号根。往根投放会让根目录长满散文件，且落盘确认的
 *     before/after 对比要枚举整盘（115 会直接风控）。
 *  2. 目标必须真的存在。115 的 /files 对已删除的 cid 会静默回落到账号根，
 *     不校验就会「显示已成功排队、其实存进了根目录」。
 */
async function verifyOwnerTarget(
  creds: NonNullable<Awaited<ReturnType<typeof getScopedStorageCredentials>>>,
  directoryId: string,
): Promise<string | null> {
  if (isRegisteredStorageProvider(creds.provider)) {
    const rootId = getStorageBrand(creds.provider).provisionRootId;
    if (rootId.length > 0 && directoryId === rootId) {
      return "不能投放到网盘根目录，请选择一个子目录";
    }
  }
  const listing = await createDriveFileManager({
    storageId: creds.id,
    provider: creds.provider,
    cookie: creds.cookie,
    credential: creds.credential,
    rootCid: creds.rootCid,
    moviesCid: creds.moviesCid,
    tvCid: creds.tvCid,
    animeCid: creds.animeCid,
  }).listDirectory(directoryId);
  // 面包屑以「从盘根到目标」的完整链路表示存在性；目标自己必须出现在链上。
  const inCrumbs = listing.breadcrumbs.some((crumb) => crumb.id === directoryId);
  if (!inCrumbs) {
    return "目标目录已不存在（可能已被删除），请重新选择";
  }
  return null;
}

export async function POST(request: NextRequest) {
  await connection();

  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;
  const accountId = gate.accountId;

  let parsed: ReturnType<typeof parseOwnerIngestSubmitBody>;
  try {
    parsed = parseOwnerIngestSubmitBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const { storageId, searchRunId, directoryId, displayPath, candidates } = parsed.body;

  const creds = await getScopedStorageCredentials(storageId);
  if (!creds) {
    return NextResponse.json({ error: "未找到该网盘，请先在设置中连接" }, { status: 404, headers: NO_STORE });
  }

  const repository = getWorkflowRepository();
  const snapshot = await loadOwnerIngestSnapshot({
    repository,
    accountId,
    connectedStorageId: creds.id,
    searchRunId,
  });
  if (snapshot === null) {
    // 检索记录不存在 / 不属于这块盘 / 已被清理 → 一律 404（fail-closed：不确认
    // 别处的检索 id 是否存在）。
    return NextResponse.json({ error: "检索记录不存在或已过期，请重新检索" }, { status: 404, headers: NO_STORE });
  }

  const results: Array<{ candidateId: string; status: string; workflowRunId?: string; reason?: string; message?: string }> = [];
  // 目标校验失败 → 422 且**不排队**（绝不制造注定失败的 run）。
  let targetProblem: string | null;
  try {
    targetProblem = await verifyOwnerTarget(creds, directoryId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "目标目录不可写" },
      { status: 422, headers: NO_STORE },
    );
  }
  if (targetProblem !== null) {
    return NextResponse.json({ error: targetProblem }, { status: 422, headers: NO_STORE });
  }
  // 绑定作品（可选）只解析一次：同一批候选用同一个 title/season。
  const binding = await resolveBinding({
    tmdbId: parsed.body.tmdbId,
    mediaType: parsed.body.mediaType,
    seasonNumber: parsed.body.seasonNumber,
    directoryId,
  });

  for (const candidateId of candidates) {
    const queued = await queueOwnerIngest({
      request: {
        accountId,
        connectedStorageId: creds.id,
        snapshot,
        candidateId,
        targetDirectoryId: directoryId,
        ...(displayPath ? { targetDisplayPath: displayPath } : {}),
        ...(binding === null ? {} : { title: binding.title, season: binding.season }),
      },
      repository,
    }).catch((error: unknown) => ({
      status: "rejected" as const,
      reason: "not_found" as const,
      copy: error instanceof Error ? error.message : "排队失败",
    }));

    if (queued.status === "queued") {
      results.push({ candidateId, status: "queued", workflowRunId: queued.workflowRunId });
    } else if (queued.status === "already_running") {
      results.push({ candidateId, status: "already_running", workflowRunId: queued.workflowRunId });
    } else {
      results.push({ candidateId, status: "rejected", reason: queued.reason, message: queued.copy });
    }
  }

  return NextResponse.json({ submissions: results }, { headers: NO_STORE });
}

/**
 * 可选的作品绑定：给了 tmdbId 就用真实身份（落盘后触发 STRM/媒体服务器联动），
 * 没给就返回 null（worker 用合成标题，纯投放）。
 *
 * 解析失败**不会**降级成「合成标题」——那会让用户以为绑定了作品、实际却没有
 * 联动。直接 422，让用户看到「这部作品取不到元数据」。
 */
async function resolveBinding(input: {
  tmdbId: number | undefined;
  mediaType: "movie" | "tv" | "anime" | undefined;
  seasonNumber: number | undefined;
  directoryId: string;
}): Promise<{ title: MediaTitle; season: TrackedSeason } | null> {
  if (input.tmdbId === undefined) return null;
  const { movieTargetFromTmdbId } = await import("../../../../../features/acquisition/application/acquisition-service");
  const { seriesTargetFor } = await import("../../../../../lib/series-target");

  if (input.mediaType === "movie") {
    const movie = await movieTargetFromTmdbId(input.tmdbId);
    if (!movie) throw new Error("NOT_FOUND: 取不到该电影元数据");
    const season = movieAnchorSeason({
      titleId: movie.title.id,
      qualityPreference: "4K",
      storageDirectoryId: input.directoryId,
    });
    return { title: movie.title, season };
  }
  const series = await seriesTargetFor(input.tmdbId);
  if (!series) throw new Error("NOT_FOUND: 取不到该剧集元数据");
  const seasonNumber = input.seasonNumber ?? 1;
  const targetSeason = series.seasons.find((entry) => entry.seasonNumber === seasonNumber);
  const titleId = series.title.id;
  return {
    title: series.title,
    season: {
      id: `${titleId}_s${seasonNumber}`,
      mediaTitleId: titleId,
      seasonNumber,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: input.directoryId,
      totalEpisodes: targetSeason?.totalEpisodes ?? 1,
      latestAiredEpisode: targetSeason?.latestAiredEpisode ?? 1,
      latestAiredSource: "metadata",
    },
  };
}
