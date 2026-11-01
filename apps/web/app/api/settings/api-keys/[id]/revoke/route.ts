import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getApiKeyV2Store } from "../../../../../../composition/runtime-container";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const store = getApiKeyV2Store();
  const revoked = await store.revokeKey(id);
  if (!revoked) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id, revoked: true });
}
