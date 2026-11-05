import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getAccountConnectedStorages } from "../../../../lib/workflow-runtime";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  try {
    const drives = await getAccountConnectedStorages(accountId);
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
