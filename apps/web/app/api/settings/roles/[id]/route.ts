import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getRoleStore } from "../../../../../composition/runtime-container";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const { id } = await context.params;
  const roleStore = getRoleStore();
  const role = await roleStore.getRole(id);
  if (!role) {
    return NextResponse.json({ error: "角色不存在" }, { status: 404 });
  }
  return NextResponse.json(role);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner) {
    return NextResponse.json({ error: "权限不足：仅系统所有者可修改角色配置" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    description?: string;
    level?: number;
    permissions?: string[];
  } | null;

  if (!body) {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }

  try {
    const roleStore = getRoleStore();
    const updated = await roleStore.updateRole(id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      description: typeof body.description === "string" ? body.description.trim() : undefined,
      level: typeof body.level === "number" ? body.level : undefined,
      permissions: Array.isArray(body.permissions)
        ? body.permissions.filter((p) => typeof p === "string")
        : undefined,
    });
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner) {
    return NextResponse.json({ error: "权限不足：仅系统所有者可删除角色" }, { status: 403 });
  }

  const { id } = await context.params;
  try {
    const roleStore = getRoleStore();
    const success = await roleStore.deleteRole(id);
    if (!success) {
      return NextResponse.json({ error: "角色不存在或无法删除" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, message: "角色已删除" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
