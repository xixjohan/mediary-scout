import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "../../../../../lib/auth-chain";
import { getScopedDriveFileManager } from "../../../../../lib/media-scope";
import { isDemoMode } from "../../../../../lib/demo-mode";
import {
  guardWriteTarget,
  libraryScopeErrorStatus,
} from "../../../../../features/storage-drives/application/library-scope-guard";

export async function POST(request: NextRequest) {
  const gate = await requirePermission(request, "storage:transfer");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  const accountId = gate.accountId;

  const body = (await request.json().catch(() => ({}))) as {
    storageId?: unknown;
    connectedStorageId?: unknown;
    parentId?: unknown;
    dirId?: unknown;
    name?: unknown;
  };

  const storageId = typeof body.storageId === "string"
    ? body.storageId
    : typeof body.connectedStorageId === "string"
      ? body.connectedStorageId
      : undefined;
  const parentId = typeof body.parentId === "string"
    ? body.parentId
    : typeof body.dirId === "string"
      ? body.dirId
      : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json({ error: "文件夹名称不能为空" }, { status: 400 });
  }

  try {
    const fileManager = await getScopedDriveFileManager(storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘" }, { status: 404 });
    }

    // 需求 2：建目录必须落在媒体库根内（成员不可在盘上任意位置造目录）
    await guardWriteTarget({
      accountId,
      storageId,
      directoryId: parentId,
      permissions: gate.permissions,
      listDirectory: (dirId) => fileManager.listDirectory(dirId),
    });
    const result = await fileManager.createFolder({ parentId, name });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[storage/files/folder] create folder failed:", error);
    const message = error instanceof Error ? error.message : "创建文件夹失败";
    return NextResponse.json({ error: message }, { status: libraryScopeErrorStatus(message) });
  }
}
