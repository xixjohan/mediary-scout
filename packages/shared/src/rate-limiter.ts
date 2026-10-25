/**
 * 可复用的调用限速原语（任务单 S3.3，P13：高频调用触发网盘封号）。
 *
 * 治理文档 §5.3 的品牌参数：
 *   - 115   漏桶 1.2s/发（burst 1）——115 对频率极敏感，宁可慢；
 *   - 夸克   令牌桶 3/s（burst 5）——容忍短突发，长期匀速。
 * 时钟与等待全部注入：单测确定性，不依赖真实时间；生产传入 Date.now / setTimeout。
 *
 * 两种 bucket 的差别正是文档要的：漏桶强制**恒定间隔**（抗持续高压），
 * 令牌桶允许**瞬时突发**（交互式批量更顺）。
 */
export interface Pacer {
  readonly kind: "leaky" | "token" | "noop";
  /** 放行前必要时等待；永不 reject（等待失败由调用方策略处理）。 */
  wait(): Promise<void>;
}

export interface PacerDeps {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** 漏桶：任意两次放行之间至少 intervalMs。 */
export class LeakyBucketPacer implements Pacer {
  readonly kind = "leaky" as const;
  private nextAllowedAt: number | null = null;
  /** 等待者串行链：并发 wait() 按到达顺序排队，不会一起放行。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: PacerDeps & { intervalMs: number },
  ) {}

  async wait(): Promise<void> {
    const run = this.tail.then(async () => {
      const now = this.options.clock();
      if (this.nextAllowedAt !== null && now < this.nextAllowedAt) {
        await this.options.sleep(this.nextAllowedAt - now);
      }
      const after = this.options.clock();
      this.nextAllowedAt = Math.max(after, this.nextAllowedAt ?? 0) + this.options.intervalMs;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 下一次放行前还需等待的毫秒数（0 = 立即可放行）。不消耗，供调用方在等待前
   *  读取以发出可观测事件（115 guard 的 delay 事件即此用法）。 */
  pendingDelayMs(): number {
    if (this.nextAllowedAt === null) {
      return 0;
    }
    return Math.max(0, this.nextAllowedAt - this.options.clock());
  }
}

/** 令牌桶：平均 perSecond 个/秒，最多积压 burst 个。 */
export class TokenBucketPacer implements Pacer {
  readonly kind = "token" as const;
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly options: PacerDeps & { perSecond: number; burst: number },
  ) {
    this.tokens = options.burst;
    this.lastRefillAt = options.clock();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.options.burst, this.tokens + (elapsed / 1000) * this.options.perSecond);
      this.lastRefillAt = now;
    }
  }

  async wait(): Promise<void> {
    this.refill(this.options.clock());
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.round(((1 - this.tokens) / this.options.perSecond) * 1000);
    await this.options.sleep(waitMs);
    this.refill(this.options.clock());
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/** 未登记品牌：不改变行为（新网盘接入时默认不加限，由其自行决定）。 */
export class NoopPacer implements Pacer {
  readonly kind = "noop" as const;
  async wait(): Promise<void> {}
}

/** 品牌 → 限速策略注册表（治理文档参数）。 */
const BRAND_PACERS: Record<string, (deps: PacerDeps) => Pacer> = {
  pan115: (deps) => new LeakyBucketPacer({ ...deps, intervalMs: 1200 }),
  quark: (deps) => new TokenBucketPacer({ ...deps, perSecond: 3, burst: 5 }),
};

export function createBrandPacer(brand: string, deps: PacerDeps): Pacer {
  return BRAND_PACERS[brand]?.(deps) ?? new NoopPacer();
}
