import { NextResponse, type NextRequest } from "next/server";
import { parseTitleWithChain, type TrackedSeasonState } from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../lib/workflow-runtime";
import { getWorkflowRepository } from "../../../../composition/runtime-container";

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
};

import type { DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";

function enrichFolderItem(
  item: DriveFileItem,
  stateByDirId: Map<string, TrackedSeasonState>,
  stateByTmdbId: Map<number, TrackedSeasonState>,
  stateByName: Map<string, TrackedSeasonState>,
): void {
  const boundState = stateByDirId.get(item.id);
  if (boundState) {
    item.mediaInfo = {
      parsedTitle: boundState.title.title,
      parsedYear: boundState.title.year,
      parsedSeason: boundState.season.seasonNumber,
      tmdbId: boundState.title.tmdbId,
      confidence: 100,
      isSubscribed: true,
      subscriptionStatus: boundState.season.status,
    };
    return;
  }

  const parsed = parseTitleWithChain({ folderName: item.name });
  if (!parsed) return;

  let matched = parsed.tmdbId ? stateByTmdbId.get(parsed.tmdbId) : undefined;
  if (!matched && parsed.title) {
    matched = stateByName.get(parsed.title.toLowerCase().trim());
  }

  item.mediaInfo = {
    ...(parsed.title ? { parsedTitle: parsed.title } : {}),
    ...(parsed.year ? { parsedYear: parsed.year } : {}),
    ...(parsed.seasonNumber ? { parsedSeason: parsed.seasonNumber } : {}),
    ...(parsed.tmdbId ?? matched?.title.tmdbId ? { tmdbId: parsed.tmdbId ?? matched?.title.tmdbId } : {}),
    confidence: parsed.confidence,
    isSubscribed: Boolean(matched),
    ...(matched ? { subscriptionStatus: matched.season.status } : {}),
  };
}

async function enrichListingWithMediaInfo(
  listing: DriveDirectoryListing,
  accountId: string,
  storageId?: string,
): Promise<void> {
  try {
    const repo = getWorkflowRepository();
    const trackedStates = await repo.listTrackedSeasonStates({
      accountId,
      connectedStorageId: storageId ?? null,
    });
    const stateByTmdbId = new Map<number, TrackedSeasonState>();
    const stateByName = new Map<string, TrackedSeasonState>();
    const stateByDirId = new Map<string, TrackedSeasonState>();

    for (const s of trackedStates) {
      if (s.title.tmdbId) stateByTmdbId.set(s.title.tmdbId, s);
      if (s.title.title) stateByName.set(s.title.title.toLowerCase().trim(), s);
      if (s.season.storageDirectoryId) stateByDirId.set(s.season.storageDirectoryId, s);
    }

    const isInsideStaging =
      listing.breadcrumbs?.some((b) => b.name.toLowerCase().startsWith("staging-")) || false;

    for (const item of listing.items) {
      if (item.isFolder) {
        if (item.name.toLowerCase().startsWith("staging-") || isInsideStaging) {
          // staging 暂存目录或 staging 内部的资源包，属于任务中间资产，不应标记为可反推
          continue;
        }
        enrichFolderItem(item, stateByDirId, stateByTmdbId, stateByName);
      }
    }
  } catch (enrichErr) {
    console.warn("[storage/files] enrichment warning (ignoring):", enrichErr);
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { searchParams } = new URL(request.url);
  const storageId = searchParams.get("storageId") || searchParams.get("connectedStorageId") || undefined;
  const dirId = searchParams.get("dirId") || searchParams.get("parentId") || undefined;

  try {
    const fileManager = await getAccountDriveFileManager(accountId, storageId);
    if (!fileManager) {
      return NextResponse.json(
        { error: "未找到连接的网盘或网盘未配置凭据" },
        { status: 404, headers: NO_CACHE_HEADERS },
      );
    }

    const listing = await fileManager.listDirectory(dirId);
    await enrichListingWithMediaInfo(listing, accountId, storageId);

    return NextResponse.json(listing, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    console.error("[storage/files] list directory failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取网盘文件列表失败" },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
