import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getUserManagementService } from "../../../../composition/runtime-container";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const isOwner = await resolveCurrentIsOwner();
  const userSvc = getUserManagementService();
  const callerRole = await userSvc.getUserRole(gate, isOwner);

  // 仅 Admin 及以上级别允许查阅系统用户列表 (level <= 20)
  if (!isOwner && callerRole.level > 20) {
    return NextResponse.json({ error: "权限不足：仅管理员可查阅用户列表" }, { status: 403 });
  }

  const users = await userSvc.listManagedUsers();
  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    password?: unknown;
    roleId?: unknown;
  } | null;

  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "必须提供用户名与初始密码" }, { status: 400 });
  }

  const userSvc = getUserManagementService();
  try {
    const created = await userSvc.createManagedUser(gate, {
      username: body.username,
      password: body.password,
      ...(typeof body.roleId === "string" && body.roleId.trim() ? { roleId: body.roleId.trim() } : {}),
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
