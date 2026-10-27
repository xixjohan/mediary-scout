import { connection, NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { isAttentionItemId } from "../../../../../lib/settings-attention";
import { dismissSettingsAttentionItem } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Per-item dismiss. Body `{id}` — id allow-listed to the shapes the builder
 *  can emit so this endpoint can't grow arbitrary account_settings keys. */
export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;
  await connection();
  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403, headers: NO_STORE });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (!id || !isAttentionItemId(id)) {
    return NextResponse.json({ error: "无效的提醒 id" }, { status: 400, headers: NO_STORE });
  }
  await dismissSettingsAttentionItem(accountId, id);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
