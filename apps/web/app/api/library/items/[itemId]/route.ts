import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";
import type { LibrarySeason } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ itemId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { itemId } = await params;
  const repo = getWorkflowRepository();
  const item = repo.mediaLibraryStore.getMediaItem(itemId);
  if (!item) {
    return NextResponse.json({ error: "影视条目不存在" }, { status: 404 });
  }

  const seasons = repo.mediaLibraryStore.listSeasons(itemId);
  const seasonsWithEpisodes = seasons.map((season: LibrarySeason) => {
    const episodes = repo.mediaLibraryStore.listEpisodes(season.id);
    return {
      ...season,
      episodes,
    };
  });

  return NextResponse.json({
    item,
    seasons: seasonsWithEpisodes,
  });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const { itemId } = await params;
  const body = (await request.json().catch(() => null)) as {
    title?: string;
    originalTitle?: string;
    releaseYear?: number;
    tmdbId?: number;
    overview?: string;
    posterPath?: string;
    backdropPath?: string;
    rating?: number;
    genres?: string[];
    isMetadataLocked?: boolean;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "无效的请求参数" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const existing = repo.mediaLibraryStore.getMediaItem(itemId);
  if (!existing) {
    return NextResponse.json({ error: "影视条目不存在" }, { status: 404 });
  }

  // 用户显式保存元数据，默认标记为锁定，防止下次被自动扫描覆盖
  const updated = repo.mediaLibraryStore.upsertMediaItem({
    ...existing,
    ...(body.title !== undefined ? { title: body.title.trim() } : {}),
    ...(body.originalTitle !== undefined ? { originalTitle: body.originalTitle.trim() } : {}),
    ...(body.releaseYear !== undefined ? { releaseYear: Number(body.releaseYear) } : {}),
    ...(body.tmdbId !== undefined ? { tmdbId: Number(body.tmdbId) } : {}),
    ...(body.overview !== undefined ? { overview: body.overview } : {}),
    ...(body.posterPath !== undefined ? { posterPath: body.posterPath } : {}),
    ...(body.backdropPath !== undefined ? { backdropPath: body.backdropPath } : {}),
    ...(body.rating !== undefined ? { rating: Number(body.rating) } : {}),
    ...(body.genres !== undefined ? { genres: body.genres } : {}),
    isMetadataLocked: body.isMetadataLocked ?? true,
    reviewStatus: "auto_accepted",
  });

  return NextResponse.json({ item: updated });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止删除" }, { status: 403 });
  }

  const { itemId } = await params;
  const repo = getWorkflowRepository();
  const ok = repo.mediaLibraryStore.deleteMediaItem(itemId);
  return NextResponse.json({ success: ok });
}
