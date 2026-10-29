import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../lib/workflow-runtime";

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
      return NextResponse.json({ error: "未找到连接的网盘或网盘未配置凭据" }, { status: 404 });
    }

    const listing = await fileManager.listDirectory(dirId);
    return NextResponse.json(listing);
  } catch (error) {
    console.error("[storage/files] list directory failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取网盘文件列表失败" },
      { status: 500 },
    );
  }
}
