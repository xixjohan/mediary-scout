import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getMediaServerCoordinator } from "../../../../composition/runtime-container";
import type { MediaServerType } from "@media-track/workflow";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    serverType?: MediaServerType;
    hostUrl?: string;
    apiToken?: string;
  } | null;

  if (!body || !body.serverType || !body.hostUrl || !body.apiToken) {
    return NextResponse.json(
      { error: "serverType, hostUrl, apiToken 均为必填项" },
      { status: 400 },
    );
  }

  const coordinator = getMediaServerCoordinator();
  const status = await coordinator.testConnection({
    serverType: body.serverType,
    hostUrl: body.hostUrl.trim(),
    apiToken: body.apiToken.trim(),
  });

  return NextResponse.json(status);
}
