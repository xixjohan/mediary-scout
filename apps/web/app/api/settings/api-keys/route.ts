import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import {
  getApiKeyV2Store,
  getUserManagementService,
} from "../../../../composition/runtime-container";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const store = getApiKeyV2Store();
  const keys = await store.listKeys();
  const isOwner = await resolveCurrentIsOwner();

  // 若不是站长，仅列出自己创建的 Key；站长可查看所有 Key
  const visibleKeys = isOwner
    ? keys
    : keys.filter((k) => k.userId === gate);

  const safeList = visibleKeys.map(({ keyHash, ...rest }) => rest);
  return NextResponse.json(safeList);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    permissions?: string[];
    allowApi?: boolean;
    allowMcp?: boolean;
    expiresAt?: number | null;
  } | null;

  if (!body || !body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "必须提供有效的 API Key 名称" }, { status: 400 });
  }

  if (body.allowApi === false && body.allowMcp === false) {
    return NextResponse.json({ error: "必须至少启用 REST API 或 MCP 中的一个访问通道" }, { status: 400 });
  }

  const permissions = Array.isArray(body.permissions)
    ? body.permissions.filter((p) => typeof p === "string")
    : [];

  const isOwner = await resolveCurrentIsOwner();
  const userSvc = getUserManagementService();
  const creatorPermissions = await userSvc.getUserPermissions(gate, isOwner);
  const securityVersion = await userSvc.getUserSecurityVersion(gate);

  try {
    const store = getApiKeyV2Store();
    const result = await store.createKey(
      {
        name: body.name.trim(),
        permissions,
        allowApi: body.allowApi,
        allowMcp: body.allowMcp,
        expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
        userId: gate,
        ownerSecurityVersion: securityVersion,
      },
      creatorPermissions,
    );

    const { keyHash, ...safeEntity } = result.entity;
    return NextResponse.json(
      {
        entity: safeEntity,
        plainTextKey: result.plainTextKey,
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 403 }
    );
  }
}
