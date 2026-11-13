import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import {
  findLibraryContextBySeasonId,
  resolveDeliveryMode,
} from "@media-track/workflow";
import type { SubtitleTrackInfo } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ episodeId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { episodeId } = await params;
  const repo = getWorkflowRepository();
  const episode = repo.mediaLibraryStore.getEpisode(episodeId);
  if (!episode) {
    return NextResponse.json({ error: "未找到该单集记录" }, { status: 404 });
  }

  // 由 seasonId 反查所属 MediaItem 与 Library。
  // 旧实现误把 listSeasons(mediaItemId) 当成按 seasonId 查询并传空串，
  // 导致 library 恒为 null、库级投送策略 100% 失效。
  const context = findLibraryContextBySeasonId(
    repo.mediaLibraryStore,
    episode.seasonId,
  );
  const mediaItem = context
    ? repo.mediaLibraryStore.getMediaItem(context.mediaItemId)
    : null;
  const library = context
    ? repo.mediaLibraryStore.getLibrary(context.libraryId)
    : null;
  const binding = episode.bindingId
    ? repo.mediaLibraryStore.getPathBinding(episode.bindingId)
    : null;
  const storage = await repo.getConnectedStorageById(episode.storageId);

  // 责任链：session > binding(非 inherit) > library > global，最终由驱动约束裁决。
  const decision = resolveDeliveryMode({
    bindingMode: binding?.deliveryMode ?? null,
    libraryMode: library?.defaultDeliveryMode ?? null,
    provider: storage?.provider ?? null,
    userAgent: request.headers.get("user-agent"),
  });

  const streamUrl = `/api/strm/play/${episode.storageId}/${episode.fileId}?name=${encodeURIComponent(episode.fileName)}`;
  const proxyUrl = `/api/strm/play/${episode.storageId}/${episode.fileId}?name=${encodeURIComponent(episode.fileName)}&delivery=proxy`;

  // 映射字幕 URL
  const subtitlesWithUrls = episode.subtitles.map((sub: SubtitleTrackInfo) => {
    if (sub.fileId) {
      return {
        ...sub,
        url: `/api/strm/play/${episode.storageId}/${sub.fileId}?name=${encodeURIComponent(sub.title)}&delivery=proxy`,
      };
    }
    return sub;
  });

  return NextResponse.json({
    episode,
    mediaItem,
    deliveryMode: decision.mode,
    deliverySource: decision.source,
    deliveryReason: decision.reason,
    streamUrl: decision.mode === "proxy" ? proxyUrl : streamUrl,
    proxyUrl,
    subtitles: subtitlesWithUrls,
  });
}
