import type { ApiKeyV2Store } from "./api-key-v2-store.js";

/**
 * WriteBehindApiKeyTouchBuffer (异步防抖写回缓存)
 *
 * 架构意图：
 * 彻底消除外部客户端/自动化脚本高频调用 API 时，每次请求直接向 SQLite 发起排他事务写锁
 * 导致的 `SQLITE_BUSY: database is locked` 数据库锁死风暴。
 *
 * 核心机制：
 * 1. 内存中维护 pending touches 映射表；
 * 2. 周期性（默认 10 秒）聚合后，单次批量事务刷入底层存储；
 * 3. 支持进程优雅关闭（SIGTERM/SIGINT）时一次性安全 flush。
 */
export class WriteBehindApiKeyTouchBuffer {
  private readonly _pending = new Map<string, number>();
  private _timer: NodeJS.Timeout | null = null;
  private _isFlushing = false;

  constructor(
    private readonly _store: ApiKeyV2Store,
    private readonly _flushIntervalMs: number = 10_000,
  ) {}

  public touch(keyId: string, timestamp: number = Date.now()): void {
    if (!keyId) return;
    const existing = this._pending.get(keyId) || 0;
    this._pending.set(keyId, Math.max(existing, timestamp));

    if (!this._timer && this._flushIntervalMs > 0) {
      this._timer = setTimeout(() => {
        this._timer = null;
        void this.flush();
      }, this._flushIntervalMs);
    }
  }

  public getPendingCount(): number {
    return this._pending.size;
  }

  public async flush(): Promise<void> {
    if (this._pending.size === 0 || this._isFlushing) {
      return;
    }

    this._isFlushing = true;
    const batch: Array<{ id: string; timestamp: number }> = [];
    for (const [id, timestamp] of this._pending.entries()) {
      batch.push({ id, timestamp });
    }
    this._pending.clear();

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    try {
      await this._store.batchTouchLastUsed(batch);
    } catch {
      // 若写入失败，重新合并回 pending，避免数据丢失
      for (const item of batch) {
        const current = this._pending.get(item.id) || 0;
        this._pending.set(item.id, Math.max(current, item.timestamp));
      }
    } finally {
      this._isFlushing = false;
    }
  }

  public async stop(): Promise<void> {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this.flush();
  }
}
