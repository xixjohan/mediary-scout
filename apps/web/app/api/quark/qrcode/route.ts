import { NextResponse } from "next/server";
import { QuarkQrLoginClient } from "@media-track/workflow";

export async function POST(): Promise<NextResponse> {
  try {
    const session = await new QuarkQrLoginClient().getToken();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
