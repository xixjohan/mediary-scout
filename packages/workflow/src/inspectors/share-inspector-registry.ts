import type { ResourceCandidate, ResourceType } from "../domain/domain.js";
import { GenericShareInspectorAdapter } from "./generic-share-inspector.js";
import { Pan115ShareInspectorAdapter } from "./pan115-share-inspector.js";
import { QuarkShareInspectorAdapter } from "./quark-share-inspector.js";
import type {
  IShareInspectorAdapter,
  ResourceInspectionResult,
} from "./share-inspector-types.js";

interface CacheEntry {
  result: ResourceInspectionResult;
  expiresAt: number;
}

export class ShareInspectorRegistry {
  private readonly adapters = new Map<ResourceType, IShareInspectorAdapter>();
  private readonly fallbackAdapter: IShareInspectorAdapter;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ResourceInspectionResult>>();

  constructor(options?: {
    customAdapters?: IShareInspectorAdapter[];
    fallbackAdapter?: IShareInspectorAdapter;
  }) {
    this.fallbackAdapter = options?.fallbackAdapter ?? new GenericShareInspectorAdapter();

    const defaults: IShareInspectorAdapter[] = [
      new QuarkShareInspectorAdapter(),
      new Pan115ShareInspectorAdapter(),
      this.fallbackAdapter,
    ];

    const toRegister = options?.customAdapters ?? defaults;
    for (const adapter of toRegister) {
      this.register(adapter);
    }
  }

  register(adapter: IShareInspectorAdapter): void {
    for (const type of adapter.supportedTypes) {
      this.adapters.set(type, adapter);
    }
  }

  async inspect(
    candidate: ResourceCandidate,
    options?: { ttlMs?: number; bypassCache?: boolean }
  ): Promise<ResourceInspectionResult> {
    const candidateId = candidate.id;
    const ttlMs = options?.ttlMs ?? 10 * 60 * 1000; // 默认缓存 10 分钟
    const now = Date.now();

    // 1. 检查缓存
    if (!options?.bypassCache) {
      const cached = this.cache.get(candidateId);
      if (cached && cached.expiresAt > now) {
        return cached.result;
      }
    }

    // 2. 并发单飞 (Single-Flight) 归并
    const active = this.inFlight.get(candidateId);
    if (active) {
      return active;
    }

    const adapter = this.adapters.get(candidate.type) ?? this.fallbackAdapter;
    const task = (async () => {
      try {
        const result = await adapter.inspect(candidate);
        // 探测成功且非临时限流则写入缓存
        if (result.status !== "rate_limited" && result.status !== "probing") {
          this.cache.set(candidateId, {
            result,
            expiresAt: Date.now() + ttlMs,
          });
        }
        return result;
      } finally {
        this.inFlight.delete(candidateId);
      }
    })();

    this.inFlight.set(candidateId, task);
    return task;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** 全局单例探测中心 */
export const defaultShareInspectorRegistry = new ShareInspectorRegistry();
