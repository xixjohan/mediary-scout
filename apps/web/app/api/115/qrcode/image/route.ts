import { type NextRequest } from "next/server";
import QRCode from "qrcode";
import { requireApiAccount } from "../../../../../lib/auth-chain";

// Render the 115 login QR code server-side locally using QRCode (zero network dependency).
// Falls back to direct generation from uid (https://115.com/scan/dg-${uid}) or content.
export async function GET(request: NextRequest): Promise<Response> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const uid = request.nextUrl.searchParams.get("uid")?.trim() ?? "";
  const content = request.nextUrl.searchParams.get("content")?.trim() ?? "";
  const qrContent = content || (uid ? `https://115.com/scan/dg-${uid}` : "");

  if (!qrContent) {
    return new Response("missing uid", { status: 400 });
  }

  try {
    const png = await QRCode.toBuffer(qrContent, { width: 220, margin: 1 });
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return new Response(`Failed to generate QR code: ${String(error)}`, { status: 500 });
  }
}
