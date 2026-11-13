import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import {
  getWorkflowRepository,
  getAccountDriveFileManager,
  getTmdbAccesses,
} from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";
import {
  MediaLibraryScanner,
  TmdbSearchProvider,
  createLibraryScanJobStore,
} from "@media-track/workflow";
import { getLibraryScanEmitter } from "../../../../../features/library/library-scan-events";
import {
  STALE_SCAN_JOB_MS,
  isTerminalScanJobStatus,
  mapJobToProgressEvent,
  transitionScanJob,
  type ScanJobEvent,
} from "../../../../../features/library/library-scan-job";
import type {
  LibraryPathBinding,
  LibraryScanProgressEvent,
} from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** 进程内取消句柄。跨实例时由 DB 的 aborted 终态兜底（下一个 signal 检查点即停）。 */
const runningControllers = new Map<string, AbortController>();

async function getOrCreateLibraryScanner(accountId: string): Promise<MediaLibraryScanner> {
  const repo = getWorkflowRepository();
  const accesses = await getTmdbAccesses(repo);
  const searchProvider = new TmdbSearchProvider({ accesses });

  return new MediaLibraryScanner({
    repo: repo.mediaLibraryStore,
    getFileManager: async (storageId: string) => {
      return getAccountDriveFileManager(accountId, storageId);
    },
    searchMetadata: async (query: string, _year?: number | null, _type?: "movie" | "tv") => {
      try {
        const results = await searchProvider.searchMedia({ query });
        const top = results[0];
        if (!top) return null;
        return {
          tmdbId: top.tmdbId,
          title: top.title,
          overview: top.overview ?? null,
          posterPath: top.posterPath ?? null,
          backdropPath: top.backdropPath ?? null,
          rating: top.voteAverage ?? null,
          releaseYear: top.year ?? null,
          genres: [],
        };
      } catch {
        return null;
      }
    },
  });
}

interface RunScanJobOptions {
  jobId: string;
  bindings: LibraryPathBinding[];
  forceFullScan: boolean;
  scanner: MediaLibraryScanner;
  signal: AbortSignal;
}

/**
 * 后台执行器。唯一事实源是 SQLite library_scan_jobs：
 * - 状态迁移一律经过显式状态机，终态不可被迟到事件覆盖；
 * - 所有 binding 全部跑完才置 succeeded，修复「首个绑定完成即结束」；
 * - 任何异常（含 try 之前的参数错误）都保证写 failed 终态；
 * - SSE 只做低延迟通知，不参与状态判定。
 */
async function runScanJob(options: RunScanJobOptions): Promise<void> {
  const { jobId, bindings, forceFullScan, scanner, signal } = options;
  const scanJobs = createLibraryScanJobStore(getWorkflowRepository().mediaLibraryStore);
  const emitter = getLibraryScanEmitter();

  if (!scanJobs.claimScanJob(jobId)) return;

  const applyTransition = (
    event: ScanJobEvent,
    patch: Parameters<typeof scanJobs.updateScanJob>[1] = {},
  ) => {
    const current = scanJobs.getScanJob(jobId);
    if (!current || isTerminalScanJobStatus(current.status)) return null;
    const next = transitionScanJob(current.status, event);
    if (!next) return null;
    return scanJobs.updateScanJob(jobId, { ...patch, status: next });
  };

  const emitSse = (stage: LibraryScanProgressEvent["stage"], message: string, error?: string) => {
    const job = scanJobs.getScanJob(jobId);
    if (!job) return;
    const event = mapJobToProgressEvent(job);
    emitter.emitProgress({ ...event, stage, message, error });
  };

  try {
    for (const binding of bindings) {
      if (signal.aborted) {
        applyTransition(
          { type: "ABORT" },
          { stage: "ABORTED", message: "扫描已取消" },
        );
        emitSse("ABORTED", "扫描已取消");
        return;
      }

      await scanner.scanBinding(binding.id, {
        forceFullScan,
        signal,
        onProgress: (progress) => {
          // 进度落库：断线、刷新页面、多实例均可从 GET 恢复。
          const current = scanJobs.getScanJob(jobId);
          if (!current || isTerminalScanJobStatus(current.status)) return;
          scanJobs.updateScanJob(jobId, {
            stage: progress.stage,
            message: progress.message,
            percent: progress.percent,
            totalDiscovered: progress.totalDiscovered,
            processedCount: progress.processedCount,
            currentTitle: progress.currentTitle ?? null,
          });
          // SSE 仅作加速通知，前端收到后回查 DB 权威状态。
          emitter.emitProgress(progress);
        },
      });
    }

    applyTransition(
      { type: "COMPLETE" },
      { stage: "COMPLETED", message: `扫描完成，共处理 ${bindings.length} 个绑定路径`, percent: 100 },
    );
    emitSse("COMPLETED", `扫描完成，共处理 ${bindings.length} 个绑定路径`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[LibraryScanRoute] 作业 ${jobId} 扫描异常:`, err);
    applyTransition(
      { type: "FAIL", reason },
      { stage: "FAILED", message: `扫描失败: ${reason}`, error: reason },
    );
    emitSse("FAILED", `扫描失败: ${reason}`, reason);
  } finally {
    runningControllers.delete(jobId);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止触发扫描" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    bindingId?: string;
    forceFullScan?: boolean;
  } | null;

  const store = getWorkflowRepository().mediaLibraryStore;
  const scanJobs = createLibraryScanJobStore(store);
  const library = store.getLibrary(id);
  if (!library) {
    return NextResponse.json({ error: "影视库不存在" }, { status: 404 });
  }

  // 崩溃恢复：把无人推进的 running 作业落到 failed 终态。
  scanJobs.recoverStaleScanJobs(id, STALE_SCAN_JOB_MS);

  // 幂等：已有活跃作业时直接返回同一 jobId，不重复启动扫描。
  const active = scanJobs.findActiveScanJob(id);
  if (active) {
    return NextResponse.json({ jobId: active.id, status: active.status, deduplicated: true });
  }

  const bindings = body?.bindingId
    ? [store.getPathBinding(body.bindingId)].filter((b): b is LibraryPathBinding => Boolean(b))
    : store.listPathBindings(id);

  if (bindings.length === 0) {
    return NextResponse.json({ error: "当前影视库尚未绑定任何网盘路径" }, { status: 400 });
  }

  const scanner = await getOrCreateLibraryScanner(accountId);
  const jobId = randomUUID();
  const controller = new AbortController();
  runningControllers.set(jobId, controller);

  try {
    scanJobs.createScanJob({
      id: jobId,
      libraryId: id,
      accountId,
      bindingIds: bindings.map((b) => b.id),
      forceFullScan: body?.forceFullScan ?? false,
    });
  } catch (err) {
    runningControllers.delete(jobId);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "创建扫描作业失败" },
      { status: 500 },
    );
  }

  void runScanJob({
    jobId,
    bindings,
    forceFullScan: body?.forceFullScan ?? false,
    scanner,
    signal: controller.signal,
  });

  return NextResponse.json({ jobId, status: "queued", bindingsCount: bindings.length });
}

/**
 * GET 有三种形态：
 *  - ?jobId=xxx  指定作业状态（前端轮询的权威裁判）
 *  - ?stream=1   SSE 低延迟加速通道（带 retry 与心跳，允许浏览器自动重连）
 *  - 无参数      该库最新作业状态（刷新页面后恢复进度）
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id } = await params;
  const store = getWorkflowRepository().mediaLibraryStore;
  const scanJobs = createLibraryScanJobStore(store);
  const jobId = request.nextUrl.searchParams.get("jobId");

  if (request.nextUrl.searchParams.get("stream") !== "1") {
    const job = jobId ? scanJobs.getScanJob(jobId) : scanJobs.getLatestScanJob(id);
    return NextResponse.json(
      { job },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const emitter = getLibraryScanEmitter();
  const stream = new ReadableStream({
    start(controller) {
      let seq = 0;
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => {};

      function cleanup() {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }

      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(payload));
        } catch {
          cleanup();
        }
      };

      unsubscribe = emitter.subscribeLibrary(id, (event: LibraryScanProgressEvent) => {
        seq += 1;
        send(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // 让浏览器按规范自动重连（前端不再在 onerror 里 close）。
      send("retry: 2000\n\n");
      send(": connected\n\n");
      heartbeat = setInterval(() => send(": keep-alive\n\n"), 15000);

      // 订阅时立即回放一次权威状态，避免「订阅晚于任务启动」丢首帧。
      const snapshot = scanJobs.getLatestScanJob(id);
      if (snapshot) {
        seq += 1;
        send(`id: ${seq}\ndata: ${JSON.stringify(mapJobToProgressEvent(snapshot))}\n\n`);
      }

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 取消扫描：写 aborted 终态 + 中止 AbortSignal（scanner 在检查点停下）。 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id } = await params;
  const store = getWorkflowRepository().mediaLibraryStore;
  const scanJobs = createLibraryScanJobStore(store);
  const jobId = request.nextUrl.searchParams.get("jobId");
  const job = jobId ? scanJobs.getScanJob(jobId) : scanJobs.getLatestScanJob(id);

  if (!job || job.libraryId !== id) {
    return NextResponse.json({ error: "未找到扫描作业" }, { status: 404 });
  }
  if (isTerminalScanJobStatus(job.status)) {
    return NextResponse.json({ job });
  }

  const next = transitionScanJob(job.status, { type: "ABORT" });
  if (!next) return NextResponse.json({ job });

  const updated = scanJobs.updateScanJob(job.id, {
    status: next,
    stage: "ABORTED",
    message: "扫描已取消",
  });
  runningControllers.get(job.id)?.abort();

  return NextResponse.json({ job: updated });
}
