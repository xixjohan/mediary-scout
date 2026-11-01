import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getExtensionManager } from "../../../../composition/runtime-container";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getExtensionManager();
  const ext = await manager.getExtension(id);
  if (!ext) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  return NextResponse.json(ext);
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getExtensionManager();
  const deleted = await manager.deleteExtension(id);
  if (!deleted) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
