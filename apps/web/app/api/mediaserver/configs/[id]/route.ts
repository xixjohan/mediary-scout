import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import type { CreateMediaServerConfigInput, UpdateMediaServerConfigInput } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const config = await repo.getMediaServerConfig(id, accountId);
  if (!config) {
    return NextResponse.json({ error: "媒体服务器配置不存在" }, { status: 404 });
  }

  const { apiTokenEncrypted, ...safe } = config;
  return NextResponse.json({ ...safe, hasToken: Boolean(apiTokenEncrypted) });
}

export async function PUT(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Partial<CreateMediaServerConfigInput> | null;
  if (!body) {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const existing = await repo.getMediaServerConfig(id, accountId);
  if (!existing) {
    return NextResponse.json({ error: "媒体服务器配置不存在" }, { status: 404 });
  }

  const updateInput: UpdateMediaServerConfigInput = {
    id,
    accountId,
  };
  if (body.name?.trim()) updateInput.name = body.name.trim();
  if (body.serverType) updateInput.serverType = body.serverType;
  if (body.hostUrl?.trim()) updateInput.hostUrl = body.hostUrl.trim();
  if (body.apiToken?.trim()) updateInput.apiToken = body.apiToken.trim();
  if (body.pathMappings) updateInput.pathMappings = body.pathMappings;
  if (typeof body.isActive === "boolean") updateInput.isActive = body.isActive;

  const updated = await repo.updateMediaServerConfig(updateInput);

  if (!updated) {
    return NextResponse.json({ error: "更新配置失败" }, { status: 500 });
  }

  const { apiTokenEncrypted, ...safe } = updated;
  return NextResponse.json({ ...safe, hasToken: Boolean(apiTokenEncrypted) });
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const deleted = await repo.deleteMediaServerConfig(id, accountId);

  if (!deleted) {
    return NextResponse.json({ error: "媒体服务器配置不存在" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
