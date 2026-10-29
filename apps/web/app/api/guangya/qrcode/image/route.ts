import { type NextRequest } from "next/server";
import QRCode from "qrcode";
import { requireApiAccount } from "../../../../../lib/auth-chain";

const MAX_URL_CONTENT_LENGTH_BYTES = 2048;
const ALLOWED_PREFIX = "https://account.guangyapan.com/";

export async function GET(request: NextRequest): Promise<Response> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const content = request.nextUrl.searchParams.get("content") ?? "";
  const tooLong = Buffer.byteLength(content, "utf8") > MAX_URL_CONTENT_LENGTH_BYTES;
  if (!content.startsWith(ALLOWED_PREFIX) || tooLong) {
    return new Response("missing/invalid content", { status: 400 });
  }
  let png: Buffer;
  try {
    png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  } catch {
    return new Response("failed to render qr code", { status: 400 });
  }
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
