import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { Pan115QrLoginClient } from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { formatNetworkError } from "../../../../lib/http-proxy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const session = await new Pan115QrLoginClient().getToken();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: formatNetworkError(error) }, { status: 502 });
  }
}
