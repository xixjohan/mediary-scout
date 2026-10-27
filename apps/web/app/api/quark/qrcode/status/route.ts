import { NextResponse, type NextRequest } from "next/server";
import { QuarkQrLoginClient } from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
  }
  try {
    const result = await new QuarkQrLoginClient().pollStatus({ token, qrcodeContent: "" });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
