import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getUserManagementService } from "../../../../../composition/runtime-container";
import { PERMISSION_CATALOG } from "@media-track/shared";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  const isOwner = await resolveCurrentIsOwner();
  const userSvc = getUserManagementService();
  const userPermissions = await userSvc.getUserPermissions(gate, isOwner);
  const userPermSet = new Set(userPermissions);
  const isSuperUser = isOwner || userPermSet.has("*");

  // 数据驱动权限向导：根据当前用户的角色能力标记每个叶子节点是否允许被勾选
  const enrichedCatalog = PERMISSION_CATALOG.map((module) => ({
    ...module,
    leaves: module.leaves.map((leaf) => ({
      ...leaf,
      isAllowed: isSuperUser || userPermSet.has(leaf.id),
    })),
  }));

  return NextResponse.json({
    isSuperUser,
    userPermissions,
    catalog: enrichedCatalog,
  });
}
