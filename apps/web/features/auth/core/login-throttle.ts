/**
 * 登录限流（暴力破解防护）。单进程自托管，用进程内 Map 即可。
 */
export type LoginVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lockCount: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BUCKETS = 10_000;

const buckets = new Map<string, Bucket>();
let maxBuckets = DEFAULT_MAX_BUCKETS;

function sweepDeadBuckets(now: number): void {
  for (const [k, v] of buckets) {
    if (now >= v.lockedUntil && now - v.windowStart > WINDOW_MS) {
      buckets.delete(k);
    }
  }
}

function makeRoomForNewBucket(now: number): boolean {
  if (buckets.size < maxBuckets) return true;
  sweepDeadBuckets(now);
  if (buckets.size < maxBuckets) return true;
  for (const [k, v] of buckets) {
    if (now < v.lockedUntil) continue;
    buckets.delete(k);
    return true;
  }
  return false;
}

function isSaturated(now: number): boolean {
  if (buckets.size < maxBuckets) return false;
  for (const v of buckets.values()) {
    if (now >= v.lockedUntil) return false;
  }
  return true;
}

export function checkLoginAllowed(key: string, now: number): LoginVerdict {
  const b = buckets.get(key);
  if (b) {
    if (now < b.lockedUntil) {
      return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }
  if (isSaturated(now)) {
    let soonest = Infinity;
    for (const v of buckets.values()) {
      if (v.lockedUntil < soonest) soonest = v.lockedUntil;
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((soonest - now) / 1000)) };
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string, now: number): void {
  let b = buckets.get(key);
  if (!b && !makeRoomForNewBucket(now)) {
    return;
  }
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { failures: 0, windowStart: now, lockedUntil: b?.lockedUntil ?? 0, lockCount: b?.lockCount ?? 0 };
  }
  b.failures += 1;
  if (b.failures >= MAX_FAILURES) {
    b.lockCount += 1;
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** (b.lockCount - 1), MAX_LOCK_MS);
    b.lockedUntil = now + lockMs;
    b.failures = 0;
    b.windowStart = now;
  }
  buckets.set(key, b);
}

export function recordLoginSuccess(key: string): void {
  buckets.delete(key);
}

export function _resetLoginThrottleForTest(): void {
  buckets.clear();
  maxBuckets = DEFAULT_MAX_BUCKETS;
}

export function _bucketCountForTest(): number {
  return buckets.size;
}

export function _setMaxBucketsForTest(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`_setMaxBucketsForTest 需要 >= 1 的整数，收到 ${n}`);
  }
  maxBuckets = n;
}

export const MAX_KEY_PART = 64;

function boundedPart(raw: string): string {
  if (raw.length <= MAX_KEY_PART) return raw;
  const lengthMarker = String(raw.length);
  const TAIL = 16;
  const headLen = MAX_KEY_PART - TAIL - lengthMarker.length - 2;
  if (headLen <= 0) return `${lengthMarker}~${raw.slice(-TAIL)}`.slice(0, MAX_KEY_PART);
  return `${raw.slice(0, headLen)}~${lengthMarker}~${raw.slice(-TAIL)}`;
}

export function normalizeThrottleKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "unknown";
  const sep = trimmed.lastIndexOf("|");
  if (sep === -1) return boundedPart(trimmed);
  return `${boundedPart(trimmed.slice(0, sep))}|${boundedPart(trimmed.slice(sep + 1))}`;
}

export function buildThrottleKey(headers: Headers, identity: string): string {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = boundedPart((cfIp || xff || "unknown").trim());
  const user = boundedPart(identity.trim());
  return `${user}|${ip}`;
}
