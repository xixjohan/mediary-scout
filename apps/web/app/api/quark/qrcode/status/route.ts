import { type NextRequest, type NextResponse } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { quarkFamilyRoutes } from "../../../cloud-family/qrcode";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  return quarkFamilyRoutes.status(request);
}
