import { NextResponse, type NextRequest } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";

/**
 * Poll device code status. Once confirmed, exchanges tokens and binds drive.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const deviceCode = request.nextUrl.searchParams.get("device_code") ?? "";
  if (!deviceCode) {
    return NextResponse.json({ ok: false, error: "缺少 device_code 参数" }, { status: 400 });
  }
  try {
    const client = new GuangYaDeviceLogin();
    const result = await client.poll(deviceCode);
    if (result.status === "confirmed") {
      const { connectGuangYa } = await import("../../../../../lib/workflow-runtime");
      const saved = await connectGuangYa(result.accessToken, result.refreshToken);
      return NextResponse.json({ ok: true, status: "confirmed", providerUid: saved.providerUid });
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
