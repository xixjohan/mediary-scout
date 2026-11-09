import { createHash } from "node:crypto";
import type { ResourceCandidate, ResourceSnapshot } from "../domain/domain.js";
import type { ResourceProvider } from "../domain/ports.js";
import {
  classifySourceFailure,
  mergeSourceHealth,
  type SourceHealth,
  type SourceStatus,
} from "../domain/resource-source-health.js";
import type { ExtensionManager } from "../extensions/extension-manager.js";
import { DynamicSearchProviderAdapter } from "../extensions/dynamic-search-provider.js";

export type SearchExecutionStrategy = "parallel" | "race" | "waterfall";

export interface ProviderCircuitState {
  status: "healthy" | "degraded" | "circuit_open" | "half_open";
  failureCount: number;
  lastFailureAt: number;
  coolDownUntil: number;
}

export interface RegisteredProviderEntry {
  id: string;
  name: string;
  provider: ResourceProvider;
  enabled: boolean;
  isDynamic: boolean;
  circuit: ProviderCircuitState;
}

export interface SearchRegistryOptions {
  strategy?: SearchExecutionStrategy | undefined;
  circuitFailureThreshold?: number | undefined; // default: 3
  circuitCoolDownMs?: number | undefined; // default: 5 min (300,000 ms)
  extensionManager?: ExtensionManager | undefined;
  now?: (() => string) | undefined;
}

const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

export class SearchProviderRegistry implements ResourceProvider {
  private readonly providers = new Map<string, RegisteredProviderEntry>();
  private readonly inFlightSearches = new Map<string, Promise<ResourceSnapshot>>();
  private readonly strategy: SearchExecutionStrategy;
  private readonly failureThreshold: number;
  private readonly coolDownMs: number;
  private readonly extensionManager: ExtensionManager | undefined;
  private readonly now: () => string;

  constructor(options: SearchRegistryOptions = {}) {
    this.strategy = options.strategy ?? "parallel";
    this.failureThreshold = options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.coolDownMs = options.circuitCoolDownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.extensionManager = options.extensionManager;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public registerProvider(entry: {
    id: string;
    name: string;
    provider: ResourceProvider;
    enabled?: boolean;
    isDynamic?: boolean;
  }): void {
    this.providers.set(entry.id, {
      id: entry.id,
      name: entry.name,
      provider: entry.provider,
      enabled: entry.enabled ?? true,
      isDynamic: entry.isDynamic ?? false,
      circuit: {
        status: "healthy",
        failureCount: 0,
        lastFailureAt: 0,
        coolDownUntil: 0,
      },
    });
  }

  public unregisterProvider(id: string): boolean {
    return this.providers.delete(id);
  }

  public setProviderEnabled(id: string, enabled: boolean): boolean {
    const entry = this.providers.get(id);
    if (!entry) return false;
    entry.enabled = enabled;
    return true;
  }

  public getProvider(id: string): RegisteredProviderEntry | undefined {
    return this.providers.get(id);
  }

  public listProviders(): RegisteredProviderEntry[] {
    return Array.from(this.providers.values());
  }

  /**
   * 同步或热加载已安装的动态扩展
   */
  public async syncExtensions(): Promise<void> {
    if (!this.extensionManager) return;
    try {
      const exts = await this.extensionManager.listExtensions();
      for (const ext of exts) {
        const providerId = `ext_${ext.manifest.id}`;
        if (!ext.manifest.enabled) {
          this.providers.delete(providerId);
          continue;
        }
        const existing = this.providers.get(providerId);
        if (!existing) {
          const adapter = new DynamicSearchProviderAdapter(ext);
          this.registerProvider({
            id: providerId,
            name: ext.manifest.name,
            provider: adapter,
            enabled: true,
            isDynamic: true,
          });
        }
      }
    } catch (err) {
      console.warn(`[SearchProviderRegistry] 扫描动态扩展失败: ${String(err)}`);
    }
  }

  /**
   * 检查并维护 Provider 的熔断状态机
   */
  private checkCircuit(entry: RegisteredProviderEntry, nowMs: number): boolean {
    if (!entry.enabled) return false;

    if (entry.circuit.status === "circuit_open") {
      if (nowMs >= entry.circuit.coolDownUntil) {
        // 冷却时间已过，进入半开探活态
        entry.circuit.status = "half_open";
        return true;
      }
      return false; // 熔断中，直接跳过该源
    }

    return true;
  }

  private recordSuccess(entry: RegisteredProviderEntry): void {
    entry.circuit.failureCount = 0;
    entry.circuit.status = "healthy";
  }

  private recordFailure(entry: RegisteredProviderEntry, nowMs: number): void {
    entry.circuit.failureCount += 1;
    entry.circuit.lastFailureAt = nowMs;

    if (entry.circuit.status === "half_open" || entry.circuit.failureCount >= this.failureThreshold) {
      entry.circuit.status = "circuit_open";
      entry.circuit.coolDownUntil = nowMs + this.coolDownMs;
      console.warn(
        `[SearchProviderRegistry] 搜索源 [${entry.name}] 连续失败 ${entry.circuit.failureCount} 次，触发熔断休眠 5 分钟`,
      );
    } else {
      entry.circuit.status = "degraded";
    }
  }

  /**
   * 实现 ResourceProvider 核心 search 端口，自带 SingleFlight 请求合并
   */
  public async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const flightKey = `${input.keyword}:${input.workflowRunId ?? "global"}`;
    const inFlight = this.inFlightSearches.get(flightKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.doSearch(input).finally(() => {
      this.inFlightSearches.delete(flightKey);
    });

    this.inFlightSearches.set(flightKey, promise);
    return promise;
  }

  private async doSearch(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const nowMs = Date.now();
    const activeEntries = Array.from(this.providers.values()).filter((e) => this.checkCircuit(e, nowMs));

    if (activeEntries.length === 0) {
      const snapshotId = `snap_empty_${Date.now()}`;
      return {
        id: snapshotId,
        provider: "registry",
        keyword: input.keyword,
        candidates: [],
        createdAt: this.now(),
        sourceHealth: { status: "unreachable", unhealthySources: ["no_active_providers"] },
      };
    }

    if (this.strategy === "parallel") {
      return this.executeParallel(activeEntries, input, nowMs);
    } else if (this.strategy === "race") {
      return this.executeRace(activeEntries, input, nowMs);
    } else {
      return this.executeWaterfall(activeEntries, input, nowMs);
    }
  }

  private async executeParallel(
    entries: RegisteredProviderEntry[],
    input: { keyword: string; workflowRunId?: string },
    nowMs: number,
  ): Promise<ResourceSnapshot> {
    const settled = await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          const res = await entry.provider.search(input);
          this.recordSuccess(entry);
          return { entry, res };
        } catch (err) {
          this.recordFailure(entry, nowMs);
          throw err;
        }
      }),
    );

    const merged: ResourceCandidate[] = [];
    const seen = new Set<string>();
    const sourceSnapshotIds: string[] = [];
    const healths: SourceHealth[] = [];

    for (const [idx, item] of settled.entries()) {
      const entry = entries[idx]!;
      if (item.status === "rejected") {
        healths.push({ status: classifySourceFailure(item.reason), source: entry.name });
        continue;
      }

      const snapshot = item.value.res;
      sourceSnapshotIds.push(snapshot.id);
      const own = snapshot.sourceHealth;
      healths.push({ status: memberStatus(own?.status), source: entry.name });

      for (const candidate of snapshot.candidates) {
        const key = dedupeKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(candidate);
      }
    }

    const snapshotId = createSnapshotId(input.keyword, sourceSnapshotIds, input.workflowRunId);
    const candidates: ResourceCandidate[] = merged.map((c, index) => ({
      ...c,
      id: `${snapshotId}_c_${index + 1}`,
      snapshotId,
      index,
    }));

    return {
      id: snapshotId,
      provider: "registry",
      keyword: input.keyword,
      candidates,
      createdAt: this.now(),
      sourceHealth: mergeSourceHealth(healths),
    };
  }

  private async executeRace(
    entries: RegisteredProviderEntry[],
    input: { keyword: string; workflowRunId?: string },
    nowMs: number,
  ): Promise<ResourceSnapshot> {
    // 竞速模式：返回最快返回有效结果的一个，若全空则返回首个完成的
    return new Promise((resolve) => {
      let completed = 0;
      let resolved = false;
      let fallbackSnapshot: ResourceSnapshot | null = null;

      for (const entry of entries) {
        entry.provider
          .search(input)
          .then((res) => {
            this.recordSuccess(entry);
            completed += 1;
            if (!resolved && res.candidates.length > 0) {
              resolved = true;
              resolve(res);
            } else if (!fallbackSnapshot) {
              fallbackSnapshot = res;
            }
            if (completed >= entries.length && !resolved) {
              resolved = true;
              resolve(fallbackSnapshot || res);
            }
          })
          .catch((err) => {
            this.recordFailure(entry, nowMs);
            completed += 1;
            if (completed >= entries.length && !resolved) {
              resolved = true;
              resolve({
                id: `snap_race_err_${Date.now()}`,
                provider: "registry",
                keyword: input.keyword,
                candidates: [],
                createdAt: this.now(),
                sourceHealth: {
                  status: classifySourceFailure(err),
                  unhealthySources: [entry.name],
                },
              });
            }
          });
      }
    });
  }

  private async executeWaterfall(
    entries: RegisteredProviderEntry[],
    input: { keyword: string; workflowRunId?: string },
    nowMs: number,
  ): Promise<ResourceSnapshot> {
    let lastSnapshot: ResourceSnapshot | null = null;
    for (const entry of entries) {
      try {
        const snapshot = await entry.provider.search(input);
        this.recordSuccess(entry);
        if (snapshot.candidates.length > 0) {
          return snapshot;
        }
        lastSnapshot = snapshot;
      } catch (err) {
        this.recordFailure(entry, nowMs);
      }
    }
    return (
      lastSnapshot ?? {
        id: `snap_waterfall_empty_${Date.now()}`,
        provider: "registry",
        keyword: input.keyword,
        candidates: [],
        createdAt: this.now(),
        sourceHealth: { status: "unreachable", unhealthySources: entries.map((e) => e.name) },
      }
    );
  }
}

function dedupeKey(candidate: ResourceCandidate): string {
  const payloadHash = candidate.providerPayload["infoHash"];
  if (typeof payloadHash === "string" && payloadHash) {
    return `btih:${payloadHash.toLowerCase()}`;
  }
  const url = candidate.providerPayload["url"];
  if (typeof url === "string" && url) {
    return `url:${url.toLowerCase()}`;
  }
  return `${candidate.title}:${candidate.type}`;
}

function createSnapshotId(keyword: string, sources: string[], workflowRunId?: string): string {
  const hash = createHash("sha1").update(`${keyword}:${sources.join(",")}`).digest("hex").slice(0, 8);
  return workflowRunId ? `snap_${workflowRunId}_${hash}` : `snap_${hash}`;
}

function memberStatus(status: string | undefined): SourceStatus {
  if (status === undefined || status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  return status === "protocol_error" ? "protocol_error" : "unreachable";
}
