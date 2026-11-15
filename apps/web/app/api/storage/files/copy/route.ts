import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "../../../../../lib/auth-chain";
import { getScopedDriveFileManager } from "../../../../../lib/media-scope";
import { isDemoMode } from "../../../../../lib/demo-mode";
import {
  guardWriteTarget,
  libraryScopeErrorStatus,
} from "../../../../../features/storage-drives/application/library-scope-guard";

function parseCopyItems(
  rawItems: unknown,
  rawFileIds: unknown,
): Array<{ id: string; isFolder: boolean }> {
  if (Array.isArray(rawItems)) {
    const items: Array<{ id: string; isFolder: boolean }> = [];
    for (const it of rawItems) {
      if (it && typeof it === "object" && "id" in it && typeof it.id === "string") {
        items.push({
          id: it.id,
          isFolder: Boolean((it as { isFolder?: unknown }).isFolder),
        });
      }
    }
    return items;
  }
  if (Array.isArray(rawFileIds)) {
    return rawFileIds.filter((id): id is string => typeof id === "string" && Boolean(id)).map((id) => ({
      id,
      isFolder: false,
    }));
  }
  return [];
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission(request, "storage:transfer");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  const accountId = gate.accountId;

  const body = (await request.json().catch(() => ({}))) as {
    storageId?: unknown;
    connectedStorageId?: unknown;
    items?: unknown;
    fileIds?: unknown;
    targetDirectoryId?: unknown;
    targetDir?: unknown;
  };

  const storageId = typeof body.storageId === "string"
    ? body.storageId
    : typeof body.connectedStorageId === "string"
      ? body.connectedStorageId
      : undefined;
  const targetDirectoryId = typeof body.targetDirectoryId === "string"
    ? body.targetDirectoryId
    : typeof body.targetDir === "string"
      ? body.targetDir
      : "";
  if (!targetDirectoryId) {
    return NextResponse.json({ error: "目标文件夹不能为空" }, { status: 400 });
  }

  const items = parseCopyItems(body.items, body.fileIds);
  if (items.length === 0) {
    return NextResponse.json({ error: "复制列表不能为空" }, { status: 400 });
  }

  try {
    const fileManager = await getScopedDriveFileManager(storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘" }, { status: 404 });
    }

    await guardWriteTarget({
      accountId,
      storageId,
      directoryId: targetDirectoryId,
      permissions: gate.permissions,
      listDirectory: (dirId) => fileManager.listDirectory(dirId),
    });
    const result = await fileManager.copyItems({ items, targetDirectoryId });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[storage/files/copy] copy failed:", error);
    const message = error instanceof Error ? error.message : "复制失败";
    return NextResponse.json({ error: message }, { status: libraryScopeErrorStatus(message) });
  }
}
