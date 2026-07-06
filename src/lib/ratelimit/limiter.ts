/**
 * IP rate limiting — sliding-window counter.
 *
 * Two backends:
 *
 *  - `MemoryBackend` (default in local dev / when no Redis env vars are set):
 *    in-memory Map. Works correctly for single-instance deployments only.
 *    Multiple serverless instances each have their own Map, so the effective
 *    limit becomes `limit × instance_count` — fine for dev, not for prod.
 *
 *  - `UpstashRedisBackend` (auto-enabled when `UPSTASH_REDIS_REST_URL` and
 *    `UPSTASH_REDIS_REST_TOKEN` are set): uses Upstash Redis as a shared
 *    counter store so limits are enforced across all instances. Required
 *    for Vercel / multi-instance serverless deployments.
 *
 * The public API is async (`rateLimit()` returns a Promise) so the Redis
 * backend can issue network calls. Callers must `await rateLimit(...)`.
 *
 * Buckets automatically expire: each entry stores its own timestamp, and
 * entries older than the window are pruned on access (Memory) or by TTL
 * (Redis sorted set + ZREMRANGEBYSCORE).
 */

import { Redis } from "@upstash/redis";

export interface RateLimitOptions {
  /** Unique identifier for this limiter (e.g. "send-otp", "api-global"). */
  key: string;
  /** Maximum number of requests allowed within the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed through. */
  ok: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Unix epoch (ms) when the limit will reset. */
  resetAt: number;
}

/** Backend abstraction — swap to Redis/KV in production without touching callers. */
interface Backend {
  /**
   * Inspect + record a hit in one atomic step. Returns the hit count
   * within the window (after adding the new hit). If the count exceeds
   * the limit, the caller treats the request as rejected (but the hit
   * is still recorded so the window count stays accurate — this is the
   * standard sliding-window-counter behaviour and is what GitHub, Stripe
   * etc. use).
   */
  hit(identifier: string, windowMs: number): Promise<number>;
  /**
   * Remove the most recent hit (rollback) — used when a request was
   * rejected and shouldn't consume quota. Optional: backends that don't
   * support atomic rollback can no-op (the count stays slightly high,
   * which is the safer side to err on).
   */
  rollback(identifier: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Memory backend                                                     */
/* ------------------------------------------------------------------ */

interface Bucket {
  /** Timestamps of allowed requests within the window. */
  hits: number[];
}

class MemoryBackend implements Backend {
  private buckets = new Map<string, Bucket>();

  async hit(identifier: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - windowMs;
    const existing = this.buckets.get(identifier);
    // Keep only timestamps within the active window.
    const hits = existing
      ? existing.hits.filter((t) => t > cutoff)
      : [];
    // Add the new hit.
    hits.push(now);
    this.buckets.set(identifier, { hits });
    return hits.length;
  }

  async rollback(identifier: string): Promise<void> {
    const bucket = this.buckets.get(identifier);
    if (bucket) bucket.hits.pop();
  }
}

/* ------------------------------------------------------------------ */
/*  Upstash Redis backend                                              */
/* ------------------------------------------------------------------ */

/**
 * Redis backend using a sorted set per identifier.
 *
 * Each member is a unique timestamp (ms since epoch); the score is the same
 * timestamp. On hit:
 *   1. ZREMRANGEBYSCORE key 0 (now - windowMs)   — prune expired entries
 *   2. ZCARD key                                 — current count
 *   3. ZADD key now now                          — record this hit
 *   4. EXPIRE key (windowMs / 1000 * 2)          — TTL safety net so the
 *      key eventually gets cleaned up even if no further requests come in
 *   5. return updated count
 *
 * Steps 1–4 are issued as a single pipeline (atomic round-trip) to keep
 * latency low and avoid race conditions between concurrent requests. There's
 * a small race window between ZCARD and ZADD, but in practice this slightly
 * over-counts during concurrent bursts — the safer side for rate limiting.
 *
 * `rollback` removes the most recent timestamp via ZPOPMAX. For high-
 * precision rollback on concurrent requests this could remove a different
 * request's timestamp, but since rollback is only used when a request is
 * rejected (which doesn't happen often under normal traffic), this is
 * acceptable.
 */
class UpstashRedisBackend implements Backend {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async hit(identifier: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - windowMs;
    // Use a unique member for ZADD — same-timestamp collisions could collapse
    // multiple hits into one if a client fires burst requests in the same ms.
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const ttlSec = Math.ceil((windowMs * 2) / 1000);

    // Pipeline: prune → count → add → expire. All sent in one round-trip.
    // Upstash pipeline returns an array of results in command order.
    const results = await this.redis.pipeline()
      .zremrangebyscore(identifier, 0, cutoff)
      // Add first, then count, so concurrent bursts don't under-count.
      .zadd(identifier, { score: now, member })
      .zcard(identifier)
      .expire(identifier, ttlSec)
      .exec();

    // results[2] is the result of zcard (the count AFTER adding the new hit).
    const count = typeof results[2] === "number" ? results[2] : 0;
    return count;
  }

  async rollback(identifier: string): Promise<void> {
    // Remove the most recent hit. ZPOPMAX removes the highest-scored member.
    await this.redis.zpopmax(identifier);
  }
}

/* ------------------------------------------------------------------ */
/*  Backend selection                                                  */
/* ------------------------------------------------------------------ */

function createBackend(): Backend {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return new UpstashRedisBackend(url, token);
  }
  // Fall back to in-memory when Redis env vars aren't set (local dev).
  return new MemoryBackend();
}

// Singleton backend. Switching between Memory and Redis is purely
// environment-driven — no code changes needed.
const backend: Backend = createBackend();

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Check whether a request should be allowed under the given rate limit,
 * and record the hit if it is. Returns the rate-limit decision.
 *
 * Rejected requests DO consume quota (the hit is recorded). This is the
 * standard sliding-window-counter behaviour used by GitHub, Stripe, etc.
 * — it makes concurrent bursts predictable and prevents retry-storms from
 * being able to squeeze in extra requests.
 */
export async function rateLimit(
  identifier: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  const fullKey = `${opts.key}:${identifier}`;
  const count = await backend.hit(fullKey, opts.windowMs);

  if (count > opts.limit) {
    // Over limit — compute when the oldest hit in the window expires.
    // Approximation: reset is `windowMs` from now, since we can't cheaply
    // fetch the oldest remaining member from Redis without an extra round-
    // trip. The `Retry-After` header this feeds is a hint, not a guarantee.
    return {
      ok: false,
      remaining: 0,
      resetAt: now + opts.windowMs,
    };
  }

  return {
    ok: true,
    remaining: Math.max(0, opts.limit - count),
    resetAt: now + opts.windowMs,
  };
}

/* ------------------------------------------------------------------ */
/*  IP extraction                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract the client IP from a Next.js request.
 *
 * Order of precedence:
 *  1. `CF-Connecting-IP` (Cloudflare, set when fronted by CF)
 *  2. `X-Forwarded-For` first entry (Vercel, generic proxies)
 *  3. `X-Real-IP` (some proxies)
 *  4. fallback to `127.0.0.1`
 *
 * Note: trust the first IP only — that is the client IP as reported by the
 * edge. Subsequent entries are upstream proxies and are not trustworthy as
 * identity.
 */
export function getClientIp(headers: Headers): string {
  const cf = headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();

  const xff = headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }

  const xreal = headers.get("X-Real-IP");
  if (xreal) return xreal.trim();

  return "127.0.0.1";
}

/**
 * Standard rate-limit response headers to attach to API responses.
 * Follows the GitHub-style header convention so clients can introspect quota.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.remaining >= 0 ? result.remaining : 0),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
  };
}

/**
 * Pre-configured limiters used across the app. Centralised here so limits
 * can be tuned in one place.
 */
export const LIMITS = {
  /** OTP send: 3 per 5 minutes per IP+email (anti-spam). */
  OTP_SEND: { key: "otp-send", limit: 3, windowMs: 5 * 60 * 1000 },
  /** OTP verify: 5 attempts per 5 minutes per IP+email (brute force). */
  OTP_VERIFY: { key: "otp-verify", limit: 5, windowMs: 5 * 60 * 1000 },
  /** Chat API: 20 per minute per user (anti-abuse on heavy LLM calls). */
  CHAT: { key: "chat", limit: 20, windowMs: 60 * 1000 },
  /** Upload: 10 per minute per IP (large payload). */
  UPLOAD: { key: "upload", limit: 10, windowMs: 60 * 1000 },
  /** Global API: 100 per minute per IP (catch-all safety net). */
  API_GLOBAL: { key: "api-global", limit: 100, windowMs: 60 * 1000 },
} as const;
