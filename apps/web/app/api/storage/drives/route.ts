import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "../../../../lib/auth-chain";
import { getAccountConnectedStorages } from "../../../../lib/workflow-runtime";
import { resolveMediaScopeAccountId } from "../../../../lib/media-scope";

export async function GET(request: NextRequest) {
  const gate = await requirePermission(request, "storage:list");
  if (gate instanceof Response) return gate;
  try {
    // shared 模式下盘属于站长，成员必须以站长账号读取才能看到公共盘。
    const drives = await getAccountConnectedStorages(await resolveMediaScopeAccountId());
    return NextResponse.json(
      { ok: true, drives, connectedStorages: drives },
      {
        headers: {
          "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  } catch (error) {
    console.error("[storage/drives] get connected storages failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取已绑定网盘列表失败" },
      {
        status: 500,
        headers: {
          "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
        },
      },
    );
  }
}
