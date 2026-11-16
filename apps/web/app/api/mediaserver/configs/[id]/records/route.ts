import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "../../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../../lib/workflow-runtime";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  const accountId = gate.accountId;

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const config = await repo.getMediaServerConfig(id, accountId);
  if (!config) {
    return NextResponse.json({ error: "媒体服务器配置不存在" }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "30", 10);

  const records = await repo.listMediaServerRefreshRecords(id, accountId, limit);
  return NextResponse.json({ records });
}
