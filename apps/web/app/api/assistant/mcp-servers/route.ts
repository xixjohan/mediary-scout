import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { getExternalMcpServerStore } from "../../../../composition/runtime-container";
import type { ExternalMcpServerEntity } from "@media-track/workflow";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const store = getExternalMcpServerStore();
  const servers = await store.listServers();
  return NextResponse.json(servers);
}

function createMcpEntity(body: Partial<ExternalMcpServerEntity>): ExternalMcpServerEntity {
  return {
    id: body.id || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: body.name?.trim() || "External MCP Server",
    enabled: body.enabled ?? true,
    transport: body.transport || "auto",
    endpointUrl: body.endpointUrl!.trim(),
    apiKey: body.apiKey?.trim() || undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 8000,
    tools: Array.isArray(body.tools) ? body.tools : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastTestedAt: null,
    lastError: null,
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as Partial<ExternalMcpServerEntity> | null;
  if (!body || !body.endpointUrl || typeof body.endpointUrl !== "string") {
    return NextResponse.json({ error: "必须提供有效的 endpointUrl" }, { status: 400 });
  }

  const server = createMcpEntity(body);
  const store = getExternalMcpServerStore();
  await store.saveServer(server);

  return NextResponse.json(server, { status: 201 });
}
