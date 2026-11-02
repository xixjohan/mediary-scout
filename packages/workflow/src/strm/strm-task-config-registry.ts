import { SingleFlight } from "./single-flight.js";
import type { StrmDeliveryMode, StrmTask } from "./strm-types.js";

/**
 * STRM 任务运行时传输交付配置（纯内存字典缓存对象）
 */
export interface StrmTaskDeliveryConfig {
  taskId: string;
  storageId: string;
  provider: string;
  deliveryMode: StrmDeliveryMode;
  accountId: string;
  isActive: boolean;
  cachedAt: number;
}

export interface StrmConfigLookupRepo {
  getTaskById: (taskId: string) => Promise<StrmTask | null>;
  getStorageById: (storageId: string) => Promise<{ provider: string; status: string; accountId?: string } | null>;
}

/**
 * STRM 任务交付配置注册中心（In-Memory Task Registry）
 *
 * 核心设计模式：
 * 1. 【单例内存字典 (In-Memory Map)】：O(1) 纳秒级检索，彻底消灭媒体流高频 Range 请求对 SQLite 数据库的 I/O 轰炸；
 * 2. 【防并发击穿 (SingleFlight)】：冷启动或 TTL 到期瞬间多个播放器 Range 并发打入时，合并为 1 次查库，其余共享结果；
 * 3. 【主动失效钩子 (Mutation Invalidation)】：任务 CRUD 时毫秒级精准淘汰缓存条目；
 * 4. 【驱动物理特性适配 (Provider Immunity)】：结合底层存储驱动（如 115 严格绑定 UA）协商安全交付模式。
 */
export class StrmTaskConfigRegistry {
  private readonly _cache = new Map<string, StrmTaskDeliveryConfig>();
  private readonly _singleFlight = new SingleFlight<StrmTaskDeliveryConfig>();
  private readonly _ttlMs: number;

  constructor(
    private readonly _lookup: StrmConfigLookupRepo,
    ttlSeconds = 120,
  ) {
    this._ttlMs = ttlSeconds * 1000;
  }

  /**
   * 根据 taskId 纳秒级快速获取已缓存的任务交付配置
   */
  async resolveConfig(taskId: string): Promise<StrmTaskDeliveryConfig> {
    const now = Date.now();
    const hit = this._cache.get(taskId);
    if (hit && now - hit.cachedAt < this._ttlMs) {
      return hit;
    }

    return this._singleFlight.do(`task-cfg:${taskId}`, async () => {
      // 双重检查防并发击穿
      const doubleCheck = this._cache.get(taskId);
      if (doubleCheck && Date.now() - doubleCheck.cachedAt < this._ttlMs) {
        return doubleCheck;
      }

      const task = await this._lookup.getTaskById(taskId);
      if (!task) {
        throw new Error(`STRM_TASK_NOT_FOUND: 未找到 ID 为 [${taskId}] 的 STRM 任务`);
      }

      const storage = await this._lookup.getStorageById(task.storageId);
      if (!storage) {
        throw new Error(`STORAGE_NOT_FOUND: 任务关联的网盘存储 [${task.storageId}] 不存在`);
      }

      const provider = storage.provider || "generic";
      let effectiveMode: StrmDeliveryMode = task.deliveryMode || "redirect";

      // 存储驱动物理特性协商：115 CDN 绑定 UA 且强制 attachment，必须以 proxy 代理中继输出
      if (provider === "pan115") {
        effectiveMode = "proxy";
      }

      const config: StrmTaskDeliveryConfig = {
        taskId: task.id,
        storageId: task.storageId,
        provider,
        deliveryMode: effectiveMode,
        accountId: task.accountId || storage.accountId || "acct_default",
        isActive: task.isActive ?? true,
        cachedAt: Date.now(),
      };

      this._cache.set(taskId, config);
      return config;
    });
  }

  /**
   * 精准淘汰指定任务缓存，若未传 taskId 则清空全量字典
   */
  invalidate(taskId?: string): void {
    if (taskId) {
      this._cache.delete(taskId);
    } else {
      this._cache.clear();
    }
  }

  /**
   * 当前字典缓存条目数（供监控和测试断言）
   */
  get size(): number {
    return this._cache.size;
  }
}
