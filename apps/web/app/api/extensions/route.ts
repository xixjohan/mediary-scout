import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../lib/auth-chain";
import { getExtensionManager } from "../../../composition/runtime-container";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const manager = getExtensionManager();
  const list = await manager.listExtensions();
  return NextResponse.json(list);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    name?: string;
  } | null;

  if (!body || !body.id || !body.name) {
    return NextResponse.json({ error: "必须提供扩展 id 和 name" }, { status: 400 });
  }

  const manager = getExtensionManager();
  const ext = await manager.createScaffolding(body.id, body.name);
  return NextResponse.json(ext, { status: 201 });
}
