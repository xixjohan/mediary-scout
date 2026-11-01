import { connection } from "next/server";
import Link from "next/link";
import { Bot } from "lucide-react";
import { ServiceBlock } from "../../../../components/layout/service-block";
import { getExternalMcpServerStore } from "../../../../composition/runtime-container";

export async function McpSection() {
  await connection();
  let serverCount = 0;
  try {
    const store = getExternalMcpServerStore();
    const list = await store.listServers();
    serverCount = list.length;
  } catch {
    serverCount = 0;
  }

  const pills = [
    {
      label: serverCount === 0 ? "未连接 MCP 服务" : `已关联 ${serverCount} 个外部服务`,
      tone: (serverCount > 0 ? "on" : "off") as "on" | "off",
    },
    { label: "动态工具注入", tone: "on" as const },
  ];

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Bot size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            外部智能体与 MCP 协议 (Model Context Protocol)
          </h2>
          <p className="panel-note">
            挂载开源社区与自建的 MCP Servers，向 AI 智能助理注入实时搜索、文件处理与本地系统工具
          </p>
        </div>
      </div>
      <ServiceBlock
        name="外部 MCP 服务协议"
        pills={pills}
        summary="遵循 Anthropic 标准 Model Context Protocol。支持通过 SSE 或 stdio 协议动态挂载外部服务与自定义自动化工具。"
      >
        <div style={{ marginTop: "0.75rem" }}>
          <Link
            href="/chat"
            className="secondary-button"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <Bot size={14} aria-hidden /> 前往智能助理抽屉管理 MCP 工具与服务
          </Link>
        </div>
      </ServiceBlock>
    </section>
  );
}
