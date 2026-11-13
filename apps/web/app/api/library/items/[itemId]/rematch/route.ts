import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getWorkflowRepository, getTmdbAccesses } from "../../../../../../lib/workflow-runtime";
import { TmdbSearchProvider } from "@media-track/workflow";
import { isDemoMode } from "../../../../../../lib/demo-mode";

interface RouteParams {
  params: Promise<{ itemId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const { itemId } = await params;
  const body = (await request.json().catch(() => null)) as {
    tmdbId?: number;
    title?: string;
  } | null;

  const repo = getWorkflowRepository();
  const existing = repo.mediaLibraryStore.getMediaItem(itemId);
  if (!existing) {
    return NextResponse.json({ error: "影视条目不存在" }, { status: 404 });
  }

  try {
    const accesses = await getTmdbAccesses(repo);
    const searchProvider = new TmdbSearchProvider({ accesses });
    let updatedMetadata: {
      tmdbId?: number | undefined;
      title: string;
      originalTitle?: string | undefined;
      overview?: string | undefined;
      posterPath?: string | undefined;
      backdropPath?: string | undefined;
      rating?: number | undefined;
      genres?: string[] | undefined;
      releaseYear?: number | undefined;
    } | null = null;

    const q = body?.title || existing.title;
    const results = await searchProvider.searchMedia({ query: q });
    const top = body?.tmdbId
      ? results.find((r) => r.tmdbId === Number(body.tmdbId)) || results[0]
      : results[0];

    if (top) {
      updatedMetadata = {
        tmdbId: top.tmdbId,
        title: top.title,
        overview: top.overview ?? undefined,
        posterPath: top.posterPath ?? undefined,
        backdropPath: top.backdropPath ?? undefined,
        rating: top.voteAverage ?? undefined,
        releaseYear: top.year ?? undefined,
      };
    }

    if (!updatedMetadata) {
      return NextResponse.json({ error: "未搜寻到相关的影视元数据" }, { status: 404 });
    }

    const updated = repo.mediaLibraryStore.upsertMediaItem({
      ...existing,
      ...(updatedMetadata.tmdbId !== undefined ? { tmdbId: updatedMetadata.tmdbId } : {}),
      title: updatedMetadata.title,
      ...(updatedMetadata.originalTitle !== undefined ? { originalTitle: updatedMetadata.originalTitle } : {}),
      ...(updatedMetadata.releaseYear !== undefined ? { releaseYear: updatedMetadata.releaseYear } : {}),
      ...(updatedMetadata.overview !== undefined ? { overview: updatedMetadata.overview } : {}),
      ...(updatedMetadata.posterPath !== undefined ? { posterPath: updatedMetadata.posterPath } : {}),
      ...(updatedMetadata.backdropPath !== undefined ? { backdropPath: updatedMetadata.backdropPath } : {}),
      ...(updatedMetadata.rating !== undefined ? { rating: updatedMetadata.rating } : {}),
      ...(updatedMetadata.genres !== undefined ? { genres: updatedMetadata.genres } : {}),
      isMetadataLocked: true,
      reviewStatus: "auto_accepted",
    });

    return NextResponse.json({ success: true, item: updated });
  } catch (err: unknown) {
    console.error("[library/rematch] 重新刮削元数据失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "重新匹配失败" },
      { status: 500 },
    );
  }
}

