import { type NextRequest, type NextResponse } from "next/server";
import { requirePermission } from "../../../../../lib/auth-chain";
import { ucFamilyRoutes } from "../../../cloud-family/qrcode";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  return ucFamilyRoutes.status(request);
}
