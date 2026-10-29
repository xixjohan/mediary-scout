import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  const accountId = gate;

  const body = (await request.json().catch(() => ({}))) as {
    storageId?: unknown;
    connectedStorageId?: unknown;
    itemId?: unknown;
    fileId?: unknown;
    newName?: unknown;
    isFolder?: unknown;
  };

  const storageId = typeof body.storageId === "string"
    ? body.storageId
    : typeof body.connectedStorageId === "string"
      ? body.connectedStorageId
      : undefined;
  const itemId = typeof body.itemId === "string"
    ? body.itemId
    : typeof body.fileId === "string"
      ? body.fileId
      : "";
  const newName = typeof body.newName === "string" ? body.newName.trim() : "";
  const isFolder = Boolean(body.isFolder);

  if (!itemId || !newName) {
    return NextResponse.json({ error: "项目ID和新名称不能为空" }, { status: 400 });
  }

  try {
    const fileManager = await getAccountDriveFileManager(accountId, storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘" }, { status: 404 });
    }

    await fileManager.renameItem({ itemId, newName, isFolder });
    return NextResponse.json({ success: true, name: newName });
  } catch (error) {
    console.error("[storage/files/rename] rename failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重命名失败" },
      { status: 500 },
    );
  }
}
