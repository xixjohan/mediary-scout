import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getFrpTunnelManager } from "../../../../../../composition/runtime-container";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getFrpTunnelManager();
  const line = await manager.getLine(id);
  if (!line) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }

  await manager.stopLine(id);
  const status = manager.getLineStatus(id);
  return NextResponse.json({ ok: true, id, status });
}
