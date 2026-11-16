import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "../../../../../../lib/auth-chain";
import { getMediaServerCoordinator } from "../../../../../../composition/runtime-container";
import { getWorkflowRepository } from "../../../../../../lib/workflow-runtime";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  const accountId = gate.accountId;

  const { id } = await context.params;
  const coordinator = getMediaServerCoordinator();

  try {
    const libraries = await coordinator.listLibraries(id, accountId);
    const repo = getWorkflowRepository();
    await repo.updateMediaServerConfig({ id, accountId, detectedLibraries: libraries }).catch(() => {});
    return NextResponse.json({ ok: true, libraries });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
