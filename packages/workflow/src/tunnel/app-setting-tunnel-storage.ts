import type { FrpTunnelLineEntity, IFrpTunnelStorage } from "@media-track/shared";
import type { WorkflowRepository } from "../persistence/repository.js";

const FRP_LINES_SETTING_KEY = "frp_tunnel_lines";

export class AppSettingTunnelStorage implements IFrpTunnelStorage {
  constructor(private readonly _repo: WorkflowRepository) {}

  public async listLines(): Promise<FrpTunnelLineEntity[]> {
    const raw = await this._repo.getSetting(FRP_LINES_SETTING_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async getLine(id: string): Promise<FrpTunnelLineEntity | null> {
    const list = await this.listLines();
    return list.find((l) => l.id === id) || null;
  }

  public async saveLine(line: FrpTunnelLineEntity): Promise<void> {
    const list = await this.listLines();
    const idx = list.findIndex((l) => l.id === line.id);
    if (idx >= 0) {
      list[idx] = line;
    } else {
      list.push(line);
    }
    await this._repo.setSetting(FRP_LINES_SETTING_KEY, JSON.stringify(list));
  }

  public async deleteLine(id: string): Promise<boolean> {
    const list = await this.listLines();
    const filtered = list.filter((l) => l.id !== id);
    if (filtered.length !== list.length) {
      await this._repo.setSetting(FRP_LINES_SETTING_KEY, JSON.stringify(filtered));
      return true;
    }
    return false;
  }
}
