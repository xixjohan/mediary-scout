import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getRoleStore } from "../../../../composition/runtime-container";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const roleStore = getRoleStore();
  const roles = await roleStore.listRoles();
  return NextResponse.json(roles);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner) {
    return NextResponse.json({ error: "权限不足：仅系统所有者可创建自定义角色" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    description?: string;
    level?: number;
    permissions?: string[];
  } | null;

  if (!body || !body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "必须提供有效的角色名称" }, { status: 400 });
  }

  const permissions = Array.isArray(body.permissions)
    ? body.permissions.filter((p) => typeof p === "string")
    : [];

  try {
    const roleStore = getRoleStore();
    const created = await roleStore.createRole({
      name: body.name.trim(),
      description: body.description?.trim(),
      level: typeof body.level === "number" ? body.level : 40,
      permissions,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
