import { connection } from "next/server";
import { Users } from "lucide-react";
import { getCurrentAccountSummary } from "../../../../lib/workflow-runtime";
import { UserManagementView } from "../user-management-view";

export async function AccountManagementSection() {
  await connection();
  const me = await getCurrentAccountSummary();
  if (!me?.isOwner) return null;

  return (
    <section id="accounts" className="panel" style={{ maxWidth: 760, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Users size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            账号与用户管理
          </h2>
          <p className="panel-note">管理多用户账号状态、委派角色与安全版本联动，支持重置用户登录密码</p>
        </div>
      </div>
      <UserManagementView />
    </section>
  );
}
