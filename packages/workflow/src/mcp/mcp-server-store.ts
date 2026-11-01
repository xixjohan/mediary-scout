import type { ExternalMcpServerEntity } from "./mcp-types.js";
import type { WorkflowRepository } from "../persistence/repository.js";

const EXTERNAL_MCP_SERVERS_KEY = "external_mcp_servers";

export class ExternalMcpServerStore {
  constructor(private readonly _repo: WorkflowRepository) {}

  public async listServers(): Promise<ExternalMcpServerEntity[]> {
    const raw = await this._repo.getSetting(EXTERNAL_MCP_SERVERS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async getServer(id: string): Promise<ExternalMcpServerEntity | null> {
    const list = await this.listServers();
    return list.find((s) => s.id === id) || null;
  }

  public async saveServer(server: ExternalMcpServerEntity): Promise<void> {
    const list = await this.listServers();
    const idx = list.findIndex((s) => s.id === server.id);
    if (idx >= 0) {
      list[idx] = server;
    } else {
      list.push(server);
    }
    await this._repo.setSetting(EXTERNAL_MCP_SERVERS_KEY, JSON.stringify(list));
  }

  public async deleteServer(id: string): Promise<boolean> {
    const list = await this.listServers();
    const filtered = list.filter((s) => s.id !== id);
    if (filtered.length !== list.length) {
      await this._repo.setSetting(EXTERNAL_MCP_SERVERS_KEY, JSON.stringify(filtered));
      return true;
    }
    return false;
  }

  public async updateToolToggle(
    serverId: string,
    toolName: string,
    enabled: boolean
  ): Promise<boolean> {
    const server = await this.getServer(serverId);
    if (!server) return false;

    const tool = server.tools.find((t) => t.name === toolName);
    if (!tool) return false;

    tool.enabled = enabled;
    server.updatedAt = Date.now();
    await this.saveServer(server);
    return true;
  }
}
