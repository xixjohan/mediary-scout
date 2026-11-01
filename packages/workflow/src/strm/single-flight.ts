/**
 * SingleFlight (单飞并发请求合并器)
 *
 * 借鉴 Go 语言 golang.org/x/sync/singleflight 与 LitePan-main 的请求合并机制。
 * 当媒体播放器（Plex/Infuse/IINA/VLC）探测视频文件（MP4 moov atom 或 MKV 容器头）时，
 * 往往在数毫秒内发起 5~10 个并发的 Range 探测请求。
 * SingleFlight 保证相同 key（如 accountId:storageId:fileId）的并发调用在内存中合并为单个底层异步执行，
 * 其余并发请求共享同一个 Promise 的解析结果，彻底杜绝请求风暴与网盘 429 封号。
 */

export class SingleFlight<T = unknown> {
  private inFlight = new Map<string, Promise<T>>();

  /**
   * 执行给定的异步函数。如果当前已有相同 key 的调用在执行中，则直接复用该 Promise。
   */
  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * 检查指定 key 当前是否正在执行中。
   */
  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * 当前并发执行中的任务数。
   */
  get size(): number {
    return this.inFlight.size;
  }
}
