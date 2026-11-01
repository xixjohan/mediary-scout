import { connection } from "next/server";
import { Globe } from "lucide-react";
import { ProxyConfigForm } from "../proxy-config-form";
import { getProxyConfigAction } from "../../../../app/actions/settings-runtime-governance-actions";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";

export async function ProxyConfigSection() {
  await connection();
  const isOwner = await resolveCurrentIsOwner();
  if (!isOwner) return null;
  const initial = await getProxyConfigAction();
  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Globe size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            网络代理设置
          </h2>
          <p className="panel-note">服务端出站请求代理（用于直连 TMDB 官方接口或 GitHub Release，支持动态热重载）</p>
        </div>
      </div>
      <ProxyConfigForm initial={initial} />
    </section>
  );
}
