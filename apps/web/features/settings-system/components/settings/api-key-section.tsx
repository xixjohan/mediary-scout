import { connection } from "next/server";
import { KeyRound } from "lucide-react";
import { isDemoMode } from "../../../../lib/demo-mode";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { readApiKeyState } from "../../../../lib/api-key-management";
import { API_KEY_SETTING_KEY } from "@media-track/shared";
import { ApiKeyPanel } from "../api-key-panel";

/**
 * S5.5 设置 → 远程访问 tab 的「API Key（开放接口）」section。
 *
 * 服务端只读三态（同一份 readApiKeyState，与 /api/settings/api-key 的 GET
 * 同源），交互全部在客户端面板里打端点。owner 门禁与 UpdateSection 一致：
 * key 是实例级凭据（/api/auth/token 用它换 JWT），不该让普通账号轮换。
 *
 * demo 站只读：不渲染（面板的写操作后端也有 403 兜底）。
 */
export async function ApiKeySection() {
  await connection();
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return null;
  const repository = getWorkflowRepository();
  const state = await readApiKeyState(process.env, {
    get: () => repository.getSetting(API_KEY_SETTING_KEY),
    set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
    clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
  });
  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <KeyRound size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            API Key（开放接口）
          </h2>
          <p className="panel-note">
            脚本和外部工具用这把 key 换一枚短期 JWT（<code>POST /api/auth/token</code>），之后所有接口带
            <code> Authorization: Bearer &lt;token&gt;</code> 访问。key 本身是长期凭据，只在这台机器的数据库里加密保存；
            完整值只在生成时显示一次，之后只剩末 4 位。
          </p>
        </div>
      </div>
      <ApiKeyPanel initial={state} />
    </section>
  );
}
