import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import {
  McpTransportClient,
  type ExternalMcpServerEntity,
} from "@media-track/workflow";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as Partial<ExternalMcpServerEntity> | null;
  if (!body || !body.endpointUrl) {
    return NextResponse.json({ error: "必须提供 endpointUrl" }, { status: 400 });
  }

  const dummyServer: ExternalMcpServerEntity = {
    id: "test_probe",
    name: body.name || "Test",
    enabled: true,
    transport: body.transport || "auto",
    endpointUrl: body.endpointUrl.trim(),
    apiKey: body.apiKey?.trim(),
    timeoutMs: body.timeoutMs || 8000,
    tools: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const client = new McpTransportClient(dummyServer);
  const start = Date.now();

  try {
    const listResult = await client.listTools();
    const latencyMs = Date.now() - start;

    return NextResponse.json({
      ok: true,
      transport: client.getResolvedTransport(),
      tools: listResult.tools || [],
      latencyMs,
    });
  } catch (error) {
    const latencyMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        error: message,
        latencyMs,
      },
      { status: 502 }
    );
  }
}
