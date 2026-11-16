import { type NextRequest, type NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/auth-chain";
import { quarkFamilyRoutes } from "../../cloud-family/qrcode";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  return quarkFamilyRoutes.token(request);
}
