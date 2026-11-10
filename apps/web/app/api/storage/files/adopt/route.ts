import { NextResponse, type NextRequest } from "next/server";
import {
  parseTitleWithChain,
  sniffMediaKind,
  inspectStorageBeforeAcquisition,
  adoptExistingMovie,
  adoptExistingTvSeason,
  buildTitleId,
  createTmdbSearchProvider,
  episodeCodeFromFileName,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";
import { seriesTargetFor } from "../../../../../lib/series-target";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../../lib/workflow-runtime";
import { getWorkflowRepository } from "../../../../../composition/runtime-container";
import { getAccountScopedSettings } from "../../../../../features/settings-system/application/system-settings-service";
import { getTmdbAccesses } from "../../../../../lib/runtime/settings-readers";

async function queryTmdbCandidate(
  title: string,
  accountId: string,
) {
  const tmdbAccesses = await getTmdbAccesses(getAccountScopedSettings(accountId));
  if (tmdbAccesses.length === 0) return null;
  try {
    const searchProvider = createTmdbSearchProvider(tmdbAccesses);
    const candidates = await searchProvider.searchMedia({ query: title, page: 1 });
    return candidates[0] ?? null;
  } catch (searchErr) {
    console.warn("[storage/files/adopt] TMDB candidate search failed:", searchErr);
    return null;
  }
}

function buildAdoptedMediaTitle(
  tmdbId: number,
  mediaKind: "movie" | "tv",
  title: string,
  year: number,
  posterPath?: string | null,
  backdropPath?: string | null,
): MediaTitle {
  return {
    id: buildTitleId({ source: "tmdb", mediaKind, id: tmdbId }),
    tmdbId,
    type: mediaKind,
    title,
    originalTitle: title,
    year,
    aliases: [],
    posterPath: posterPath ?? null,
    backdropPath: backdropPath ?? null,
  };
}

interface ResolvedIdentity {
  tmdbId?: number | undefined;
  title: string;
  year: number;
  tmdbMediaType?: "movie" | "tv" | undefined;
  posterPath?: string | null | undefined;
  backdropPath?: string | null | undefined;
}

async function findResolvedIdentity(
  folderName: string,
  parsed: ReturnType<typeof parseTitleWithChain>,
  accountId: string,
  explicitTmdbId?: number,
): Promise<ResolvedIdentity> {
  const parsedTitle = parsed ? parsed.title : undefined;
  let tmdbId = explicitTmdbId ? explicitTmdbId : (parsed ? parsed.tmdbId : undefined);
  let title = parsedTitle ? parsedTitle : folderName;
  let year = parsed && parsed.year ? parsed.year : 2024;
  let tmdbMediaType: "movie" | "tv" | undefined;
  let posterPath: string | null | undefined;
  let backdropPath: string | null | undefined;

  if (!tmdbId && parsedTitle) {
    const topMatch = await queryTmdbCandidate(parsedTitle, accountId);
    if (topMatch) {
      tmdbId = topMatch.tmdbId;
      title = topMatch.title;
      year = topMatch.year;
      tmdbMediaType = topMatch.mediaType;
      posterPath = topMatch.posterPath ?? null;
      backdropPath = topMatch.backdropPath ?? null;
    }
  }

  return { tmdbId, title, year, tmdbMediaType, posterPath, backdropPath };
}

interface ResolveAdoptionParams {
  folderName: string;
  items?: Array<{ name: string; isFolder: boolean; type?: string }> | undefined;
  explicitTmdbId?: number | undefined;
  explicitMediaKind?: "movie" | "tv" | undefined;
  seasonNumber?: number | undefined;
  parentFolderName?: string | undefined;
  accountId: string;
}

async function resolveSeriesSeasonAdoption(params: {
  tmdbId: number;
  seasonNumber?: number | undefined;
  folderName: string;
}): Promise<{ titleObj: MediaTitle; mediaKind: "tv"; seasonNum: number } | null> {
  try {
    const target = await seriesTargetFor(params.tmdbId);
    if (!target?.title) return null;
    const match = /(?:Season\s*(\d+)|[Ss](\d{1,2})|第\s*(\d+)\s*季)/i.exec(params.folderName.trim());
    const seasonNum = params.seasonNumber ?? (match ? Number(match[1] || match[2] || match[3]) : 1);
    return {
      titleObj: target.title,
      mediaKind: "tv",
      seasonNum,
    };
  } catch {
    return null;
  }
}

async function resolveMetadataForAdoption(params: ResolveAdoptionParams): Promise<{
  titleObj: MediaTitle;
  mediaKind: "movie" | "tv";
  seasonNum: number;
} | null> {
  const { folderName, items, explicitTmdbId, explicitMediaKind, accountId } = params;
  const parentParsed = params.parentFolderName
    ? parseTitleWithChain({ folderName: params.parentFolderName })
    : null;
  const targetTmdbId = explicitTmdbId ?? parentParsed?.tmdbId;

  if (targetTmdbId) {
    const seriesResult = await resolveSeriesSeasonAdoption({
      tmdbId: targetTmdbId,
      seasonNumber: params.seasonNumber,
      folderName,
    });
    if (seriesResult) return seriesResult;
  }

  const parsed = parseTitleWithChain({ folderName });
  const resolved = await findResolvedIdentity(folderName, parsed, accountId, explicitTmdbId);

  if (!resolved.tmdbId) return null;

  const mediaKind = sniffMediaKind({
    folderName,
    parsedSeason: parsed?.seasonNumber,
    items,
    preferredCategory: explicitMediaKind,
    tmdbMediaType: resolved.tmdbMediaType,
  });

  return {
    titleObj: buildAdoptedMediaTitle(
      resolved.tmdbId,
      mediaKind,
      resolved.title,
      resolved.year,
      resolved.posterPath,
      resolved.backdropPath,
    ),
    mediaKind,
    seasonNum: parsed?.seasonNumber ?? 1,
  };
}

async function adoptMovieFolder(params: {
  fileManager: Awaited<ReturnType<typeof getAccountDriveFileManager>>;
  repo: ReturnType<typeof getWorkflowRepository>;
  accountId: string;
  storageId?: string | undefined;
  folderId: string;
  titleObj: MediaTitle;
}): Promise<string> {
  const { fileManager, repo, accountId, storageId, folderId, titleObj } = params;
  if (!fileManager) throw new Error("网盘管理器未就绪");

  const inspectRes = await inspectStorageBeforeAcquisition({
    storage: fileManager,
    mediaKind: "movie",
    title: titleObj.title,
    year: titleObj.year,
    tmdbId: titleObj.tmdbId,
    categoryParentId: folderId,
  });

  const videoFiles =
    inspectRes.mediaKind === "movie" && inspectRes.videoFiles.length > 0
      ? inspectRes.videoFiles
      : (await fileManager.listDirectory(folderId)).items
          .filter((i) => !i.isFolder && (i.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(i.name)))
          .map((i) => ({ id: i.id, name: i.name, sizeBytes: i.sizeBytes }));

  return adoptExistingMovie({
    title: titleObj,
    repository: repo,
    accountId,
    connectedStorageId: storageId,
    directoryId: folderId,
    videoFiles,
  });
}

function collectTvFolderEpisodes(
  items: Array<{ name: string; isFolder: boolean; type?: string; id: string; sizeBytes?: number }>,
  seasonNum: number,
) {
  const directVideos = items.filter(
    (i) => !i.isFolder && (i.type === "video" || /\.(mp4|mkv|avi|mov|iso|ts)$/i.test(i.name)),
  );
  return directVideos.map((v, idx) => {
    const code = episodeCodeFromFileName(v.name, seasonNum);
    const match = code ? /E(\d+)/i.exec(code) : null;
    const epNum = match ? Number(match[1]) : idx + 1;
    return {
      episodeNumber: epNum,
      seasonNumber: seasonNum,
      episodeCode: code ?? `S${String(seasonNum).padStart(2, "0")}E${String(idx + 1).padStart(2, "0")}`,
      fileId: v.id,
      fileName: v.name,
      sizeBytes: v.sizeBytes ?? 0,
    };
  });
}

async function resolveTvSeasonMetadata(
  titleObj: MediaTitle,
  seasonNum: number,
  directCount: number,
): Promise<{ totalEpisodes: number; latestAired: number }> {
  try {
    const target = await seriesTargetFor(titleObj.tmdbId);
    const targetSeason = target?.seasons.find((s) => s.seasonNumber === seasonNum);
    if (targetSeason) {
      const total = targetSeason.totalEpisodes || directCount || 12;
      const latest = targetSeason.latestAiredEpisode || total;
      return { totalEpisodes: total, latestAired: latest };
    }
  } catch {}
  const fallback = Math.max(directCount, 12);
  return { totalEpisodes: fallback, latestAired: fallback };
}

async function adoptTvFolder(params: {
  fileManager: Awaited<ReturnType<typeof getAccountDriveFileManager>>;
  repo: ReturnType<typeof getWorkflowRepository>;
  accountId: string;
  storageId?: string | undefined;
  folderId: string;
  titleObj: MediaTitle;
  seasonNum: number;
}): Promise<string> {
  const { fileManager, repo, accountId, storageId, folderId, titleObj, seasonNum } = params;
  if (!fileManager) throw new Error("网盘管理器未就绪");

  const listing = await fileManager.listDirectory(folderId).catch(() => null);
  const directEpisodes = collectTvFolderEpisodes(listing?.items ?? [], seasonNum);
  const { totalEpisodes, latestAired } = await resolveTvSeasonMetadata(
    titleObj,
    seasonNum,
    directEpisodes.length,
  );

  const targetCoverage = latestAired > 0 ? latestAired : totalEpisodes;
  const isFull = directEpisodes.length >= targetCoverage && targetCoverage > 0;

  const trackedSeason: TrackedSeason = {
    id: `${titleObj.id}_s${seasonNum}`,
    mediaTitleId: titleObj.id,
    seasonNumber: seasonNum,
    status: isFull ? "completed" : "active",
    qualityPreference: "1080p",
    storageDirectoryId: folderId,
    totalEpisodes,
    latestAiredEpisode: latestAired,
    latestAiredSource: "metadata",
  };

  return adoptExistingTvSeason({
    title: titleObj,
    season: trackedSeason,
    repository: repo,
    accountId,
    connectedStorageId: storageId,
    directoryId: folderId,
    existingEpisodes: directEpisodes,
    isFull,
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  let body: {
    storageId?: string | undefined;
    folderId: string;
    folderName: string;
    tmdbId?: number | undefined;
    mediaKind?: "movie" | "tv" | undefined;
    seasonNumber?: number | undefined;
    parentFolderName?: string | undefined;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  }

  const { storageId, folderId, folderName } = body;
  if (!folderId || !folderName) {
    return NextResponse.json({ error: "缺少文件夹 ID 或名称" }, { status: 400 });
  }

  try {
    const fileManager = await getAccountDriveFileManager(accountId, storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘" }, { status: 404 });
    }

    const listing = await fileManager.listDirectory(folderId).catch(() => null);
    const items = listing?.items ?? [];

    const resolved = await resolveMetadataForAdoption({
      folderName,
      items,
      explicitTmdbId: body.tmdbId,
      explicitMediaKind: body.mediaKind,
      seasonNumber: body.seasonNumber,
      parentFolderName: body.parentFolderName,
      accountId,
    });
    if (!resolved) {
      return NextResponse.json(
        { error: `未能识别目录「${folderName}」对应的影视元数据，请确认目录名称包含标准影视名或 TMDB 标签` },
        { status: 422 },
      );
    }

    const repo = getWorkflowRepository();
    const { titleObj, mediaKind, seasonNum } = resolved;

    if (mediaKind === "movie") {
      const runId = await adoptMovieFolder({ fileManager, repo, accountId, storageId, folderId, titleObj });
      return NextResponse.json({
        success: true,
        workflowRunId: runId,
        message: `已成功将电影「${titleObj.title}」纳入订阅与媒体库！`,
      });
    }

    const runId = await adoptTvFolder({ fileManager, repo, accountId, storageId, folderId, titleObj, seasonNum });
    return NextResponse.json({
      success: true,
      workflowRunId: runId,
      message: `已成功将剧集「${titleObj.title}」第 ${seasonNum} 季纳入订阅与媒体库！`,
    });
  } catch (error) {
    console.error("[storage/files/adopt] adoption failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "纳入订阅失败" },
      { status: 500 },
    );
  }
}
