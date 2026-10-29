import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getAccountDriveFileManager } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";

function parseDeleteItems(
  rawItems: unknown,
  rawFileIds: unknown,
): Array<{ id: string; isFolder: boolean; name?: string }> {
  if (Array.isArray(rawItems)) {
    const items: Array<{ id: string; isFolder: boolean; name?: string }> = [];
    for (const it of rawItems) {
      if (it && typeof it === "object" && "id" in it && typeof it.id === "string") {
        const name = typeof (it as { name?: unknown }).name === "string" ? String((it as { name: unknown }).name) : undefined;
        items.push({
          id: it.id,
          isFolder: Boolean((it as { isFolder?: unknown }).isFolder),
          ...(name ? { name } : {}),
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
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  const accountId = gate;

  const body = (await request.json().catch(() => ({}))) as {
    storageId?: unknown;
    connectedStorageId?: unknown;
    items?: unknown;
    fileIds?: unknown;
  };

  const storageId = typeof body.storageId === "string"
    ? body.storageId
    : typeof body.connectedStorageId === "string"
      ? body.connectedStorageId
      : undefined;
  const items = parseDeleteItems(body.items, body.fileIds);
  if (items.length === 0) {
    return NextResponse.json({ error: "删除列表不能为空" }, { status: 400 });
  }

  try {
    const fileManager = await getAccountDriveFileManager(accountId, storageId);
    if (!fileManager) {
      return NextResponse.json({ error: "未找到连接的网盘" }, { status: 404 });
    }

    const result = await fileManager.deleteItems(items);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[storage/files/delete] delete failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除失败" },
      { status: 500 },
    );
  }
}
