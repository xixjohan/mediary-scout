import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../../lib/demo-mode";
import { requirePermission } from "../../../../../../lib/auth-chain";
import { executeStrmTaskScan } from "../../../../../../features/strm/application/strm-runner-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  const accountId = gate.accountId;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;

  // 不再传 `request.nextUrl.origin`。容器内看到的 origin 是回环地址
  // （`http://localhost:3000`），而它是 `resolveEffectiveStrmBaseUrl` 的最高优先级，
  // 会覆盖 DB/env 里的真实播放基址——2026-11-17 实测：一次「立即扫描」把 178 个
  // 本来正确的 `.strm` 全部改写成 localhost，外部播放器随即全挂。
  // 基址只认 SSOT（DB 设置 → APP_BASE_URL/MEDIARY_URL → 回环兜底 + 告警）。
  const result = await executeStrmTaskScan(id, accountId, {
    triggerSource: "manual",
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
