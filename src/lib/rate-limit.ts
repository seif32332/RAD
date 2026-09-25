// Simple in-memory fixed-window rate limiter (per Node process).
// Good enough for a single instance per tenant; use Redis if you scale horizontally.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Counts one hit for `key`. Returns ok=false once `limit` hits happen within `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= limit;
  return { ok, remaining: Math.max(0, limit - b.count), retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000) };
}

/** Gives back one hit for `key` (e.g. a login that turned out to be successful). */
export function refundRateLimit(key: string) {
  const b = buckets.get(key);
  if (b && b.count > 0) b.count -= 1;
}

/** Clears the counter for `key` (e.g. after a successful login). */
export function resetRateLimit(key: string) {
  buckets.delete(key);
}
