import type { FrpTunnelLineEntity, FrpTunnelLineStatus, FrpTunnelLogItem } from "./tunnel-protocol.js";
import { FrpTunnelClient } from "./frp-tunnel-client.js";

/**
 * 穿透线路存储接口
 */
export interface IFrpTunnelStorage {
  listLines(): Promise<FrpTunnelLineEntity[]>;
  getLine(id: string): Promise<FrpTunnelLineEntity | null>;
  saveLine(line: FrpTunnelLineEntity): Promise<void>;
  deleteLine(id: string): Promise<boolean>;
}

/**
 * 内存实现（用于单元测试及临时场景）
 */
export class InMemoryFrpTunnelStorage implements IFrpTunnelStorage {
  private _lines = new Map<string, FrpTunnelLineEntity>();

  public async listLines(): Promise<FrpTunnelLineEntity[]> {
    return Array.from(this._lines.values());
  }

  public async getLine(id: string): Promise<FrpTunnelLineEntity | null> {
    return this._lines.get(id) || null;
  }

  public async saveLine(line: FrpTunnelLineEntity): Promise<void> {
    this._lines.set(line.id, { ...line, updatedAt: Date.now() });
  }

  public async deleteLine(id: string): Promise<boolean> {
    return this._lines.delete(id);
  }
}

/**
 * FRP 穿透服务管理中心 (Facade)
 */
export class FrpTunnelManager {
  private readonly _storage: IFrpTunnelStorage;
  private readonly _clients = new Map<string, FrpTunnelClient>();

  constructor(storage: IFrpTunnelStorage) {
    this._storage = storage;
  }

  public async listLines(): Promise<Array<FrpTunnelLineEntity & { status: FrpTunnelLineStatus }>> {
    const lines = await this._storage.listLines();
    return lines.map((line) => {
      const client = this._clients.get(line.id);
      return {
        ...line,
        status: client ? client.getStatus() : {
          id: line.id,
          state: "Disconnected",
          publicUrl: null,
          connectedAt: null,
          sentBytes: 0,
          receivedBytes: 0,
          lastError: null,
          recentLogs: [],
        },
      };
    });
  }

  public async getLine(id: string): Promise<FrpTunnelLineEntity | null> {
    return this._storage.getLine(id);
  }

  public getLogs(id: string): FrpTunnelLogItem[] {
    const client = this._clients.get(id);
    return client ? client.getLogs() : [];
  }

  public async saveLine(line: FrpTunnelLineEntity): Promise<void> {
    await this._storage.saveLine(line);
    // 若正在运行，则平滑重启以应用新配置
    const existingClient = this._clients.get(line.id);
    if (existingClient) {
      await existingClient.stop();
      this._clients.delete(line.id);
      if (line.autoStart) {
        await this.startLine(line.id);
      }
    }
  }

  public async deleteLine(id: string): Promise<boolean> {
    const client = this._clients.get(id);
    if (client) {
      await client.stop();
      this._clients.delete(id);
    }
    return this._storage.deleteLine(id);
  }

  public async startLine(id: string): Promise<void> {
    const line = await this._storage.getLine(id);
    if (!line) throw new Error(`未找到穿透线路: ${id}`);

    let client = this._clients.get(id);
    if (!client) {
      client = new FrpTunnelClient(line);
      this._clients.set(id, client);
    }
    await client.start();
  }

  public async stopLine(id: string): Promise<void> {
    const client = this._clients.get(id);
    if (client) {
      await client.stop();
    }
  }

  public getLineStatus(id: string): FrpTunnelLineStatus {
    const client = this._clients.get(id);
    return client ? client.getStatus() : {
      id,
      state: "Disconnected",
      publicUrl: null,
      connectedAt: null,
      sentBytes: 0,
      receivedBytes: 0,
      lastError: null,
      recentLogs: [],
    };
  }

  public async stopAll(): Promise<void> {
    for (const client of this._clients.values()) {
      await client.stop();
    }
    this._clients.clear();
  }
}
