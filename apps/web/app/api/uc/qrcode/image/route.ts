import { type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { ucFamilyRoutes } from "../../../cloud-family/qrcode";

export async function GET(request: NextRequest): Promise<Response> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  return ucFamilyRoutes.image(request);
}
