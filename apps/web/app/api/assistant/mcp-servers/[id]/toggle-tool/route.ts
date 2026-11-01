import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getExternalMcpServerStore } from "../../../../../../composition/runtime-container";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    toolName?: string;
    enabled?: boolean;
  } | null;

  if (!body || !body.toolName || typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "缺少 toolName 或 enabled 布尔值参数" },
      { status: 400 }
    );
  }

  const store = getExternalMcpServerStore();
  const ok = await store.updateToolToggle(id, body.toolName, body.enabled);
  if (!ok) {
    return NextResponse.json({ error: "未找到对应的 MCP 服务或工具" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, serverId: id, toolName: body.toolName, enabled: body.enabled });
}
