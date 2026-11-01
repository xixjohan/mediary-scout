import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { getFrpTunnelManager } from "../../../../composition/runtime-container";
import type { FrpTunnelLineEntity } from "@media-track/shared";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const manager = getFrpTunnelManager();
  const lines = await manager.listLines();
  return NextResponse.json(lines);
}

function createTunnelLineEntity(body: Partial<FrpTunnelLineEntity>): FrpTunnelLineEntity {
  return {
    id: body.id || `frp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: body.name?.trim() || "ProxyByCF Line",
    enabled: body.enabled ?? false,
    serverUrl: body.serverUrl!.trim(),
    backupServerUrls: Array.isArray(body.backupServerUrls) ? body.backupServerUrls : [],
    tunnelHost: body.tunnelHost!.trim(),
    apiKey: body.apiKey!.trim(),
    localTargetUrl: body.localTargetUrl!.trim(),
    allowLanStreamingOverride: body.allowLanStreamingOverride ?? true,
    activeStreamsWindow: body.activeStreamsWindow ?? 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as Partial<FrpTunnelLineEntity> | null;
  if (!body || !body.serverUrl || !body.tunnelHost || !body.apiKey || !body.localTargetUrl) {
    return NextResponse.json(
      { error: "缺少必填字段: serverUrl, tunnelHost, apiKey, localTargetUrl" },
      { status: 400 }
    );
  }

  const line = createTunnelLineEntity(body);
  const manager = getFrpTunnelManager();
  await manager.saveLine(line);

  return NextResponse.json(line, { status: 201 });
}
