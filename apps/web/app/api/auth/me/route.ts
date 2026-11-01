import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../platform/next-context/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { BUILTIN_ROLES, ROLE_LEVELS } from "@media-track/shared";

/**
 * GET /api/auth/me
 * 获取当前登录用户的详细档案、角色层级、权限清单与关联资产概况。
 */
export async function GET(request: NextRequest) {
  const accountId = await requireApiAccount(request);
  if (typeof accountId !== "string") {
    return accountId;
  }

  const repo = getWorkflowRepository();
  const account = await repo.getAccountById(accountId);
  if (!account) {
    return NextResponse.json({ ok: false, error: "ACCOUNT_NOT_FOUND" }, { status: 404 });
  }

  const storages = await repo.listConnectedStorages(accountId);

  const isOwner = Boolean(account.isOwner);
  const roleId = isOwner ? "role_owner" : "role_member";
  const roleEntity = BUILTIN_ROLES[roleId] ?? {
    id: roleId,
    name: isOwner ? "站长 (Owner)" : "标准成员 (Member)",
    level: isOwner ? ROLE_LEVELS.OWNER : ROLE_LEVELS.MEMBER,
    permissions: isOwner ? ["*"] : [],
    isSystem: true,
    description: "",
    createdAt: 0,
    updatedAt: 0,
  };

  return NextResponse.json(
    {
      ok: true,
      user: {
        id: account.id,
        username: account.username,
        isOwner,
        role: {
          id: roleEntity.id,
          name: roleEntity.name,
          level: roleEntity.level,
        },
        permissions: isOwner ? ["*"] : roleEntity.permissions,
        storageCount: storages.length,
        createdAt: account.createdAt,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, private",
      },
    },
  );
}
