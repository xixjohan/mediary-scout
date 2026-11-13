import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import type { MediaReviewStatus } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const mediaType = searchParams.get("type") as "movie" | "tv" | null;
  const reviewStatus = searchParams.get("review") as MediaReviewStatus | null;
  const query = searchParams.get("q") || undefined;
  const limit = Number(searchParams.get("limit") || 50);
  const offset = Number(searchParams.get("offset") || 0);

  const repo = getWorkflowRepository();

  // 第一道防线：活跃路径守卫 (Active Path Guard)
  // 当指定特定库且尚未绑定任何有效网盘路径时，自动清理残留孤儿数据并返回空列表
  if (id !== "all") {
    const bindings = repo.mediaLibraryStore.listPathBindings(id);
    if (bindings.length === 0) {
      repo.mediaLibraryStore.purgeOrphanedLibraryItems(id);
      return NextResponse.json({
        items: [],
        total: 0,
        hasBindings: false,
      });
    }
  }

  const result = repo.mediaLibraryStore.listMediaItems({
    ...(id !== "all" ? { libraryId: id } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(query ? { query } : {}),
    limit,
    offset,
  });

  return NextResponse.json({
    ...result,
    hasBindings: true,
  });
}
