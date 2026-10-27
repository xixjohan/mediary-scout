/**
 * Spacing for one drive's API calls, shared by the staging janitor and the recovery
 * runs it queues (a recovery starts while the janitor is still walking the same drive).
 * 123 answers a burst with code=100011 / 请勿频繁操作: its calls are spaced, and a
 * refused call waits 30s, then 60s, then 120s and is retried; the fourth refusal, or
 * any other error, propagates. Other brands are not spaced (115 paces itself) and
 * never answer with 123's refusal.
 *
 * The interval is REGISTRY DATA (`StorageBrand.minApiIntervalMs`), not a
 * `provider === "pan123"` check — a brand that needs spacing must say so in its
 * entry, and the field is required so a new drive cannot silently ship unlimited.
 */
import { getStorageBrand, isRegisteredStorageProvider } from "./storage-brands.js";

export interface DriveClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Run one drive call through the spacing and the rate-limit retry. */
export type DrivePace = <T>(run: () => Promise<T>) => Promise<T>;

/** One paced call can paginate. 123 answers the burst with code=100011.
 *  Three waits, then give up. */
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000];

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /code=100011|请勿频繁操作/.test(message);
}

export const realtimeDriveClock: DriveClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function minIntervalMs(provider: string | undefined): number {
  // Unknown/absent provider → no spacing, exactly as before. A registered brand
  // that somehow lacks the field also degrades to 0 rather than throwing here:
  // this runs on every drive call, and a registry typo should not turn into a
  // crash loop. The registry test pins the field's presence instead.
  if (provider === undefined || !isRegisteredStorageProvider(provider)) {
    return 0;
  }
  return getStorageBrand(provider).minApiIntervalMs ?? 0;
}

/** Start-to-start gap. The first call does not wait. gap 0 never sleeps. */
export function drivePacer(provider: string | undefined, clock: DriveClock = realtimeDriveClock): DrivePace {
  const gapMs = minIntervalMs(provider);
  let last = Number.NEGATIVE_INFINITY;
  return async function pace<T>(run: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (gapMs > 0 && Number.isFinite(last)) {
        const wait = gapMs - (clock.now() - last);
        if (wait > 0) {
          await clock.sleep(wait);
        }
      }
      if (gapMs > 0) {
        last = clock.now();
      }
      try {
        return await run();
      } catch (error) {
        const backoff = RATE_LIMIT_BACKOFF_MS[attempt];
        if (backoff === undefined || !isRateLimited(error)) {
          throw error;
        }
        attempt += 1;
        await clock.sleep(backoff);
      }
    }
  };
}
