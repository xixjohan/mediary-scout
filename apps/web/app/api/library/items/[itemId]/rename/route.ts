import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getWorkflowRepository, getAccountDriveFileManager } from "../../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../../lib/demo-mode";

interface RouteParams {
  params: Promise<{ itemId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改网盘文件" }, { status: 403 });
  }

  const { itemId } = await params;
  const body = (await request.json().catch(() => null)) as {
    episodeId?: string;
    newFileName?: string;
  } | null;

  if (!body || !body.episodeId || !body.newFileName || !body.newFileName.trim()) {
    return NextResponse.json({ error: "必须提供集数ID与规范化新文件名" }, { status: 400 });
  }

  const newFileName = body.newFileName.trim();
  const repo = getWorkflowRepository();
  const episode = repo.mediaLibraryStore.getEpisode(body.episodeId);
  if (!episode) {
    return NextResponse.json({ error: "未找到该单集记录" }, { status: 404 });
  }

  try {
    const fileManager = await getAccountDriveFileManager(accountId, episode.storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未能连接到网盘驱动" }, { status: 404 });
    }

    // 1. 调用网盘驱动修改网盘真实物理文件名称
    await fileManager.renameItem({
      itemId: episode.fileId,
      newName: newFileName,
      isFolder: false,
    });

    // 2. 同步更新本地 SQLite 数据库中的单集名称
    repo.mediaLibraryStore.updateEpisodeFileName(episode.id, newFileName);

    return NextResponse.json({
      success: true,
      episodeId: episode.id,
      fileName: newFileName,
    });
  } catch (err: unknown) {
    console.error("[library/rename] 修改网盘真实文件名失败:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "重命名失败" },
      { status: 500 },
    );
  }
}
