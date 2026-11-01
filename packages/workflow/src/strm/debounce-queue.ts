/**
 * DebounceQueue (防抖队列与抖动控制器)
 *
 * 用于 STRM 批量写入通知与媒体服务器局部刷新的抖动控制（Jitter Control）。
 * 针对剧集多集批量入库、扫描任务密集变动等场景：
 * 1. 静默防抖窗口 (debounceMs)：当最后一次事件触发后等待一段时间再执行；
 * 2. 最大等待上限 (maxWaitMs)：防止高频事件源源不断导致任务无限期饥饿延迟；
 * 3. 异步并发互斥 (concurrency lock)：保证同一队列不会并发重入执行 flush；
 * 4. 自动去重与合并 (keyFn / deduplication)。
 */

export interface DebounceQueueOptions<T> {
  debounceMs: number;
  maxWaitMs?: number;
  onFlush: (items: T[]) => Promise<void> | void;
  keyFn?: (item: T) => string;
}

export class DebounceQueue<T> {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onFlush: (items: T[]) => Promise<void> | void;
  private readonly keyFn: (item: T) => string;

  private items = new Map<string, T>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private windowStartTime = 0;
  private isFlushing = false;
  private hasPendingFlushWhileFlushing = false;

  constructor(options: DebounceQueueOptions<T>) {
    this.debounceMs = options.debounceMs;
    this.maxWaitMs = options.maxWaitMs ?? options.debounceMs * 4;
    this.onFlush = options.onFlush;
    this.keyFn = options.keyFn ?? ((item: T) => JSON.stringify(item));
  }

  /**
   * 将一个或多个条目推入防抖队列。
   */
  push(...items: T[]): void {
    if (items.length === 0) return;

    for (const item of items) {
      const key = this.keyFn(item);
      this.items.set(key, item);
    }

    const now = Date.now();
    if (!this.windowStartTime) {
      this.windowStartTime = now;
    }

    const elapsed = now - this.windowStartTime;
    if (elapsed >= this.maxWaitMs) {
      void this.flush();
      return;
    }

    // 动态计算等待延时：不得超过最大等待窗口所剩时间
    const remainingMaxWait = Math.max(0, this.maxWaitMs - elapsed);
    const delay = Math.min(this.debounceMs, remainingMaxWait);

    // 重置静默防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  /**
   * 立即刷新并处理当前队列中的所有条目。
   */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.isFlushing) {
      this.hasPendingFlushWhileFlushing = true;
      return;
    }

    if (this.items.size === 0) {
      this.windowStartTime = 0;
      return;
    }

    const snapshot = Array.from(this.items.values());
    this.items.clear();
    this.windowStartTime = 0;
    this.isFlushing = true;

    try {
      await this.onFlush(snapshot);
    } finally {
      this.isFlushing = false;
      if (this.hasPendingFlushWhileFlushing) {
        this.hasPendingFlushWhileFlushing = false;
        if (this.items.size > 0) {
          void this.flush();
        }
      }
    }
  }

  /**
   * 取消当前所有待刷新的定时器并清空队列。
   */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.items.clear();
    this.windowStartTime = 0;
    this.hasPendingFlushWhileFlushing = false;
  }

  /**
   * 释放资源（cancel 的别名）
   */
  dispose(): void {
    this.cancel();
  }

  /**
   * 当前队列中待处理项数。
   */
  get size(): number {
    return this.items.size;
  }

  /**
   * 是否正在执行刷新任务。
   */
  get flushing(): boolean {
    return this.isFlushing;
  }
}
