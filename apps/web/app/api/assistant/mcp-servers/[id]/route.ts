import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getExternalMcpServerStore } from "../../../../../composition/runtime-container";
import type { ExternalMcpServerEntity } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const store = getExternalMcpServerStore();
  const server = await store.getServer(id);
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json(server);
}

export async function PUT(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const store = getExternalMcpServerStore();
  const existing = await store.getServer(id);
  if (!existing) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as Partial<ExternalMcpServerEntity> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const updated: ExternalMcpServerEntity = {
    ...existing,
    name: body.name !== undefined ? body.name.trim() : existing.name,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    transport: body.transport !== undefined ? body.transport : existing.transport,
    endpointUrl: body.endpointUrl !== undefined ? body.endpointUrl.trim() : existing.endpointUrl,
    apiKey: body.apiKey !== undefined ? body.apiKey.trim() : existing.apiKey,
    timeoutMs: body.timeoutMs !== undefined ? body.timeoutMs : existing.timeoutMs,
    tools: Array.isArray(body.tools) ? body.tools : existing.tools,
    updatedAt: Date.now(),
  };

  await store.saveServer(updated);
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const store = getExternalMcpServerStore();
  const deleted = await store.deleteServer(id);
  if (!deleted) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
