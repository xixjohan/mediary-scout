import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository, getTmdbAccesses } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";
import {
  TmdbSearchProvider,
  createAgentModelFromEnv,
  matchMediaItemsWithAi,
} from "@media-track/workflow";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    itemIds?: string[];
  } | null;

  if (!body || !Array.isArray(body.itemIds) || body.itemIds.length === 0) {
    return NextResponse.json({ error: "必须指定至少一个要匹配的影视条目 ID" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const accesses = await getTmdbAccesses(repo);
  const tmdbProvider = new TmdbSearchProvider({ accesses });
  const model = createAgentModelFromEnv();

  // 收集待匹配项的信息
  const candidateInputs = [];
  for (const itemId of body.itemIds) {
    const item = repo.mediaLibraryStore.getMediaItem(itemId);
    if (!item) continue;

    // 尝试搜集该条目下的部分文件名，提供给 LLM 参考
    const seasons = repo.mediaLibraryStore.listSeasons(itemId);
    const sampleFiles: string[] = [];
    for (const season of seasons) {
      const eps = repo.mediaLibraryStore.listEpisodes(season.id);
      for (const ep of eps) {
        sampleFiles.push(ep.fileName);
        if (sampleFiles.length >= 3) break;
      }
      if (sampleFiles.length >= 3) break;
    }

    candidateInputs.push({
      id: item.id,
      rawTitle: item.title,
      sampleFiles,
      mediaType: item.mediaType,
    });
  }

  try {
    const response = await matchMediaItemsWithAi({
      model,
      repo: repo.mediaLibraryStore,
      tmdbProvider,
      items: candidateInputs,
    });

    return NextResponse.json(response);
  } catch (err: unknown) {
    console.error("[batch-rematch] 批量 AI 匹配失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "批量 AI 匹配异常" },
      { status: 500 },
    );
  }
}
