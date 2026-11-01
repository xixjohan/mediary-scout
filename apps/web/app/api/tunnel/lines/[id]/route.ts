import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getFrpTunnelManager } from "../../../../../composition/runtime-container";
import type { FrpTunnelLineEntity } from "@media-track/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getFrpTunnelManager();
  const line = await manager.getLine(id);
  if (!line) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }

  const status = manager.getLineStatus(id);
  return NextResponse.json({ line, status });
}

export async function PUT(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getFrpTunnelManager();
  const existing = await manager.getLine(id);
  if (!existing) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as Partial<FrpTunnelLineEntity> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const updated: FrpTunnelLineEntity = {
    ...existing,
    name: body.name !== undefined ? body.name.trim() : existing.name,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    serverUrl: body.serverUrl !== undefined ? body.serverUrl.trim() : existing.serverUrl,
    backupServerUrls: Array.isArray(body.backupServerUrls) ? body.backupServerUrls : existing.backupServerUrls,
    tunnelHost: body.tunnelHost !== undefined ? body.tunnelHost.trim() : existing.tunnelHost,
    apiKey: body.apiKey !== undefined ? body.apiKey.trim() : existing.apiKey,
    localTargetUrl: body.localTargetUrl !== undefined ? body.localTargetUrl.trim() : existing.localTargetUrl,
    allowLanStreamingOverride: body.allowLanStreamingOverride !== undefined ? body.allowLanStreamingOverride : existing.allowLanStreamingOverride,
    activeStreamsWindow: body.activeStreamsWindow !== undefined ? body.activeStreamsWindow : existing.activeStreamsWindow,
    updatedAt: Date.now(),
  };

  await manager.saveLine(updated);
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getFrpTunnelManager();
  const deleted = await manager.deleteLine(id);
  if (!deleted) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
