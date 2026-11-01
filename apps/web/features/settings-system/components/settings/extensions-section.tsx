import { connection } from "next/server";
import Link from "next/link";
import { Box } from "lucide-react";
import { ServiceBlock } from "../../../../components/layout/service-block";
import { getExtensionManager } from "../../../../composition/runtime-container";

export async function ExtensionsSection() {
  await connection();
  const manager = getExtensionManager();
  const list = await manager.listExtensions().catch(() => []);
  const enabledCount = list.filter((e) => e.manifest.enabled).length;

  const pills = [
    {
      label: list.length === 0 ? "未安装扩展" : `已安装 ${list.length} 个扩展 (${enabledCount} 已启用)`,
      tone: (list.length > 0 ? "on" : "off") as "on" | "off",
    },
    { label: "child_process 沙箱硬隔离", tone: "on" as const },
  ];

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Box size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            动态扩展与插件
          </h2>
          <p className="panel-note">热插拔盘搜与元数据提取扩展，基于子进程沙箱隔离运行，支持在线热编辑与自愈快照</p>
        </div>
      </div>
      <ServiceBlock
        name="资源提供商扩展 (Dynamic Extensions)"
        pills={pills}
        summary="支持导入开源社区盘搜插件包或新建脚手架由 AI 编写，零重启热插拔与快照版本回滚。"
        details={
          list.length > 0 ? (
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.4rem" }}>
              {list.map((ext) => (
                <div key={ext.manifest.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.85rem" }}>
                  <Box size={14} />
                  <strong>{ext.manifest.name}</strong>
                  <span className="badge" style={{ fontSize: "0.75rem" }}>v{ext.manifest.version}</span>
                  <code>{ext.manifest.id}</code>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                    ({ext.manifest.entry})
                  </span>
                </div>
              ))}
            </div>
          ) : undefined
        }
      >
        <div style={{ marginTop: "0.75rem" }}>
          <Link
            href="/settings/extensions"
            className="secondary-button"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <Box size={14} aria-hidden /> 前往扩展与插件管理
          </Link>
        </div>
      </ServiceBlock>
    </section>
  );
}
