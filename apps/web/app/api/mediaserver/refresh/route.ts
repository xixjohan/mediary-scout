import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getMediaServerCoordinator } from "../../../../composition/runtime-container";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    configId?: string;
    targetPath?: string;
  } | null;

  if (!body || !body.configId) {
    return NextResponse.json({ error: "configId 必填" }, { status: 400 });
  }

  const coordinator = getMediaServerCoordinator();
  const result = await coordinator.manualRefresh(
    body.configId,
    accountId,
    body.targetPath?.trim(),
  );

  return NextResponse.json(result);
}
