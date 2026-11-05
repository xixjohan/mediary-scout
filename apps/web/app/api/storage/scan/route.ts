import { NextResponse, type NextRequest } from "next/server";
import {
  runReverseStorageScan,
  createTmdbSearchProvider,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../lib/workflow-runtime";
import { getWorkflowRepository } from "../../../../composition/runtime-container";
import { getAccountScopedSettings } from "../../../../features/settings-system/application/system-settings-service";
import { getTmdbAccesses } from "../../../../lib/runtime/settings-readers";

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
};

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  let body: {
    storageId?: string | undefined;
    targetCid?: string | undefined;
    category?: "movie" | "tv" | "anime" | "auto" | undefined;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  }

  const { storageId, category = "auto" } = body;
  if (!storageId) {
    return NextResponse.json({ error: "缺少 storageId" }, { status: 400 });
  }

  try {
    const fileManager = await getAccountDriveFileManager(accountId, storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘或网盘未配置凭据" }, { status: 404 });
    }

    const repo = getWorkflowRepository();
    const storageRecord = await repo.getConnectedStorageById(storageId);
    if (!storageRecord) {
      return NextResponse.json({ error: "网盘记录不存在" }, { status: 404 });
    }

    const targetCid = body.targetCid || storageRecord.rootCid || "0";

    const job = await repo.createReverseScanJob({
      accountId,
      storageId,
      targetCid,
      category,
    });

    // Resolve TMDB accesses for metadata resolution
    const tmdbAccesses = await getTmdbAccesses(getAccountScopedSettings(accountId));
    const searchProvider = tmdbAccesses.length > 0 ? createTmdbSearchProvider(tmdbAccesses) : undefined;

    // Trigger asynchronous scanning loop (non-blocking for HTTP response)
    void runReverseStorageScan({
      fileManager,
      storageProvider: storageRecord.provider,
      jobId: job.id,
      accountId,
      storageId,
      targetCid,
      category,
      repo,
      searchProvider,
      storageCids: {
        moviesCid: storageRecord.moviesCid,
        tvCid: storageRecord.tvCid,
        animeCid: storageRecord.animeCid,
      },
    });

    return NextResponse.json({ job }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    console.error("[storage/scan] failed to start scan job:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "启动扫描任务失败" },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  const storageId = searchParams.get("storageId");

  const repo = getWorkflowRepository();

  if (jobId) {
    const job = await repo.getReverseScanJob(jobId);
    if (!job || job.accountId !== accountId) {
      return NextResponse.json({ error: "任务不存在" }, { status: 404, headers: NO_CACHE_HEADERS });
    }
    const items = await repo.listReverseScanItems(jobId);
    return NextResponse.json({ job, items }, { headers: NO_CACHE_HEADERS });
  }

  const jobs = await repo.listReverseScanJobs(accountId, 10);
  const filtered = storageId ? jobs.filter((j) => j.storageId === storageId) : jobs;
  return NextResponse.json({ jobs: filtered }, { headers: NO_CACHE_HEADERS });
}
