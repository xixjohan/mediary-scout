import { connection } from "next/server";
import Link from "next/link";
import { Tv } from "lucide-react";
import { ServiceBlock } from "../../../../components/layout/service-block";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { DEFAULT_ACCOUNT_ID } from "@media-track/workflow";

export async function MediaServerSection() {
  await connection();
  const repo = getWorkflowRepository();
  const configs = await repo.listMediaServerConfigs(DEFAULT_ACCOUNT_ID);
  const activeCount = configs.filter((c) => c.isActive).length;
  const pills = [
    {
      label: configs.length === 0 ? "未配置" : `已关联 ${configs.length} 台 (${activeCount} 台已启用)`,
      tone: (configs.length > 0 ? "on" : "off") as "on" | "off",
    },
    { label: "防抖局部刷新", tone: "on" as const },
  ];

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Tv size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            家庭影院与影视库
          </h2>
          <p className="panel-note">Plex / Emby / Jellyfin 媒体服务器自动通知与 STRM 入库联动</p>
        </div>
      </div>
      <ServiceBlock
        name="媒体服务器 (Plex / Emby / Jellyfin)"
        pills={pills}
        summary="关联家庭影院影视库，支持入库/STRM 变更后自动精准局部刷新、抖动聚合防抖控制与路径映射。"
        details={
          configs.length > 0 ? (
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.4rem" }}>
              {configs.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.85rem" }}>
                  <Tv size={14} />
                  <strong>{c.name}</strong>
                  <span className="badge" style={{ textTransform: "uppercase", fontSize: "0.75rem" }}>{c.serverType}</span>
                  <code>{c.hostUrl}</code>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                    ({c.pathMappings.length} 组路径映射)
                  </span>
                </div>
              ))}
            </div>
          ) : undefined
        }
      >
        <div style={{ marginTop: "0.75rem" }}>
          <Link
            href="/settings/mediaserver"
            className="secondary-button"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <Tv size={14} aria-hidden /> 前往影视库配置与管理
          </Link>
        </div>
      </ServiceBlock>
    </section>
  );
}
