import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requirePermission } from "../../../../../lib/auth-chain";
import {
  getApiKeyV2Store,
  getUserManagementService,
} from "../../../../../composition/runtime-container";
import type { UpdateApiKeyV2Input } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const { id } = await context.params;
  const store = getApiKeyV2Store();
  const entity = await store.getKey(id);
  if (!entity) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner && entity.userId !== gate.accountId) {
    return new Response(null, { status: 404 });
  }

  const { keyHash, ...safeEntity } = entity;
  return NextResponse.json(safeEntity);
}

export async function PATCH(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const { id } = await context.params;
  const store = getApiKeyV2Store();
  const existingKey = await store.getKey(id);
  if (!existingKey) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const isOwner = await resolveCurrentIsOwner();
  // 多租户隔离防护：非 Owner 仅可编辑属于自身的 API Key
  if (!isOwner && existingKey.userId !== gate.accountId) {
    return NextResponse.json({ error: "无权修改其他用户的 API Key" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as UpdateApiKeyV2Input | null;
  if (!body) {
    return NextResponse.json({ error: "无效的请求负载" }, { status: 400 });
  }

  const userSvc = getUserManagementService();
  const actorPermissions = await userSvc.getUserPermissions(gate.accountId, isOwner);

  try {
    const updated = await store.updateKey(
      id,
      {
        name: body.name,
        permissions: body.permissions,
        allowApi: body.allowApi,
        allowMcp: body.allowMcp,
        expiresAt: body.expiresAt,
      },
      actorPermissions
    );

    const { keyHash, ...safeEntity } = updated;
    return NextResponse.json({ ok: true, entity: safeEntity });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requirePermission(request, "system:settings");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const { id } = await context.params;
  const store = getApiKeyV2Store();
  const existingKey = await store.getKey(id);
  if (!existingKey) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner && existingKey.userId !== gate.accountId) {
    return NextResponse.json({ error: "无权删除其他用户的 API Key" }, { status: 403 });
  }

  const deleted = await store.deleteKey(id);
  if (!deleted) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
