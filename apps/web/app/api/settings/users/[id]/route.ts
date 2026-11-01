import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getUserManagementService } from "../../../../../composition/runtime-container";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const { id: targetUserId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    action: "set_role" | "set_active" | "reset_password";
    roleId?: string;
    isActive?: boolean;
    newPassword?: string;
  } | null;

  if (!body || !body.action) {
    return NextResponse.json({ error: "操作指令 action 缺失" }, { status: 400 });
  }

  const userSvc = getUserManagementService();

  try {
    switch (body.action) {
      case "set_role": {
        if (!body.roleId) {
          return NextResponse.json({ error: "必须提供目标 roleId" }, { status: 400 });
        }
        await userSvc.setUserRole(gate, targetUserId, body.roleId);
        return NextResponse.json({ ok: true, message: "角色分配成功，该用户的 API Key 已联动更新" });
      }

      case "set_active": {
        if (typeof body.isActive !== "boolean") {
          return NextResponse.json({ error: "必须提供布尔值 isActive" }, { status: 400 });
        }
        await userSvc.setUserActive(gate, targetUserId, body.isActive);
        return NextResponse.json({
          ok: true,
          message: body.isActive ? "账号已重新启用" : "账号已停用，所有会话与 API Key 已冻结",
        });
      }

      case "reset_password": {
        if (!body.newPassword || body.newPassword.length < 6) {
          return NextResponse.json({ error: "新密码至少 6 位" }, { status: 400 });
        }
        await userSvc.resetUserPassword(gate, targetUserId, body.newPassword);
        return NextResponse.json({ ok: true, message: "密码重置成功，旧会话已注销" });
      }

      default:
        return NextResponse.json({ error: "未知的操作指令" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 403 }
    );
  }
}
