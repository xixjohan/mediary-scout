import { NextResponse, type NextRequest } from "next/server";
import { completeQuarkQrLogin } from "../../../../../lib/workflow-runtime";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { serviceTicket?: string };
    if (!body.serviceTicket) {
      return NextResponse.json({ ok: false, error: "missing serviceTicket" }, { status: 400 });
    }
    const result = await completeQuarkQrLogin(body.serviceTicket);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
