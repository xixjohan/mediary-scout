import { connection } from "next/server";
import { KeyRound } from "lucide-react";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { ApiKeyV2Manager } from "../api-key-v2-manager";

/**
 * 设置 → 开放接口与 API Key 授权管理板块 (V2 树状细粒度权限体系)
 */
export async function ApiKeySection() {
  await connection();
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return null;

  return (
    <section className="panel" style={{ maxWidth: 760, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <KeyRound size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            API Key 与应用授权管理 (V2)
          </h2>
          <p className="panel-note">
            基于树状权限矩阵与动态工具投影的细粒度应用凭据管理。支持为外部 AI Agent、自动化脚本或第三方工具按需签发受限凭据，具备过期时间与一次性明文揭示防护。
          </p>
        </div>
      </div>
      <ApiKeyV2Manager />
    </section>
  );
}
