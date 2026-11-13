import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import {
  PLAYER_DELIVERY_MODE_SETTING_KEY,
  findLibraryContextBySeasonId,
  parsePlayerDeliveryPreference,
  resolveDeliveryMode,
  toSessionOverride,
} from "@media-track/workflow";
import type { SubtitleTrackInfo } from "@media-track/contracts";
import { buildPlayStreamUrls } from "../../../../../features/player/play-stream-url";

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

  // P2-B：账号级投送偏好作为责任链最高优先级的 session override。
  // 读取失败一律降级为「无覆盖」，绝不因为偏好存储故障阻断播放。
  const storedPreference = await repo
    .getAccountSetting(gate, PLAYER_DELIVERY_MODE_SETTING_KEY)
    .catch(() => null);
  const sessionOverride = toSessionOverride(
    parsePlayerDeliveryPreference(storedPreference),
  );

  // 责任链：session > binding(非 inherit) > library > global，最终由驱动约束裁决。
  const decision = resolveDeliveryMode({
    sessionOverride,
    bindingMode: binding?.deliveryMode ?? null,
    libraryMode: library?.defaultDeliveryMode ?? null,
    provider: storage?.provider ?? null,
    userAgent: request.headers.get("user-agent"),
  });

  // pickCode 是 115 直链解析的最优路径入参：
  // 1) 开放平台只认 pickCode，缺省会整条跳过；
  // 2) Cookie 路径缺省时会先多调一次 getFileInfo 换取 pickCode。
  // 单集记录在扫描阶段已落库（library-scanner 写入 pick_code），此处透传即可。
  const { streamUrl: baseStreamUrl, proxyUrl } = buildPlayStreamUrls({
    storageId: episode.storageId,
    fileId: episode.fileId,
    fileName: episode.fileName,
    pickCode: episode.pickCode,
  });
  const streamUrl = decision.mode === "proxy" ? proxyUrl : baseStreamUrl;

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
    streamUrl,
    proxyUrl,
    subtitles: subtitlesWithUrls,
  });
}
