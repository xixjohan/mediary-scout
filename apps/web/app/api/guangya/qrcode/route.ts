import { NextResponse, type NextRequest } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";

/**
 * Mint a 光鸭 login session via device-code flow.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ ok: false, error: "演示站只读" }, { status: 403 });
  try {
    const code = await new GuangYaDeviceLogin().start();
    return NextResponse.json({ ok: true, ...code });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
