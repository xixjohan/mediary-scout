import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../../../lib/auth-chain";
import { getWorkflowRepository, getAccountDriveFileManager } from "../../../../../../../lib/workflow-runtime";
import type { PathConnectionTestResult } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ id: string; bindingId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id: libraryId, bindingId } = await params;
  const repo = getWorkflowRepository();
  const binding = repo.mediaLibraryStore.getPathBinding(bindingId);

  if (!binding || binding.libraryId !== libraryId) {
    return NextResponse.json({ error: "绑定的路径不存在" }, { status: 404 });
  }

  const accountId = (gate as { accountId?: string }).accountId || "acct_default";
  const startTime = Date.now();

  try {
    const fileManager = await getAccountDriveFileManager(accountId, binding.storageId);
    if (!fileManager) {
      return NextResponse.json<PathConnectionTestResult>({
        success: false,
        latencyMs: Date.now() - startTime,
        error: `无法初始化网盘驱动 (${binding.storageId})，请检查凭据授权`,
      });
    }

    const listing = await fileManager.listDirectory(binding.remoteFolderId);
    const latencyMs = Date.now() - startTime;

    return NextResponse.json<PathConnectionTestResult>({
      success: true,
      latencyMs,
      fileCount: listing.items.length,
      folderName: listing.currentDirectoryName || binding.remotePath,
    });
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    return NextResponse.json<PathConnectionTestResult>({
      success: false,
      latencyMs,
      error: err instanceof Error ? err.message : "连接网盘超时或目录不可达",
    });
  }
}
