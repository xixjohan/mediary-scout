import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import type { CreateMediaServerConfigInput, MediaServerConfig } from "@media-track/workflow";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const repo = getWorkflowRepository();
  const configs = await repo.listMediaServerConfigs(accountId);
  // 脱敏返回：不泄露加密密文
  const safeConfigs = configs.map((c: MediaServerConfig) => {
    const { apiTokenEncrypted, ...rest } = c;
    return {
      ...rest,
      hasToken: Boolean(apiTokenEncrypted),
    };
  });
  return NextResponse.json(safeConfigs);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Partial<CreateMediaServerConfigInput> | null;
  if (!body) {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  if (!body.name || !body.serverType || !body.hostUrl || !body.apiToken) {
    return NextResponse.json(
      { error: "name, serverType, hostUrl, apiToken 均为必填项" },
      { status: 400 },
    );
  }

  const repo = getWorkflowRepository();
  const config = await repo.createMediaServerConfig({
    accountId,
    name: body.name.trim(),
    serverType: body.serverType,
    hostUrl: body.hostUrl.trim(),
    apiToken: body.apiToken.trim(),
    pathMappings: body.pathMappings || [],
    detectedLibraries: body.detectedLibraries || [],
    isActive: body.isActive ?? true,
  });

  const { apiTokenEncrypted, ...safeConfig } = config;
  return NextResponse.json(
    { ...safeConfig, hasToken: Boolean(apiTokenEncrypted) },
    { status: 201 },
  );
}
