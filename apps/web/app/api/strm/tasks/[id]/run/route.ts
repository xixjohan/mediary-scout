import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { executeStrmTaskScan } from "../../../../../../features/strm/application/strm-runner-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const origin = request.nextUrl.origin || "http://localhost:3000";

  const result = await executeStrmTaskScan(id, accountId, {
    triggerSource: "manual",
    baseUrl: origin,
  });

  if (!result.ok) {
    const status = result.errorMessage === "STRM 任务不存在" ? 404 : 400;
    return NextResponse.json({ error: result.errorMessage }, { status });
  }

  return NextResponse.json({
    ok: true,
    scanResult: result.scanResult,
    recordId: result.recordId,
  });
}
