import { connection } from "next/server";
import { ShieldCheck } from "lucide-react";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { RoleManagementPanel } from "../role-management-panel";

export async function RoleManagementSection() {
  await connection();
  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner) return null;

  return (
    <section id="roles" className="panel" style={{ maxWidth: 760, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <ShieldCheck size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            角色与权限控制 (RBAC)
          </h2>
          <p className="panel-note">
            基于三态模块权限树的角色模型。支持按角色勾选细粒度功能权限，并作为 API Key 凭据签发的最外层授权边界。
          </p>
        </div>
      </div>
      <RoleManagementPanel />
    </section>
  );
}
