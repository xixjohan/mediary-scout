import { type NextRequest } from "next/server";
import { requirePermission } from "../../../../../lib/auth-chain";
import { ucFamilyRoutes } from "../../../cloud-family/qrcode";

export async function GET(request: NextRequest): Promise<Response> {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  return ucFamilyRoutes.image(request);
}
