/**
 * Durable, cross-instance rate limiter backed by Upstash Redis.
 *
 * Uses @upstash/ratelimit (sliding-window algorithm) so counters persist
 * across redeploys and are consistent regardless of which serverless instance
 * handles a request. Requires the following environment variables:
 *
 *   UPSTASH_REDIS_REST_URL   – REST endpoint for your Upstash Redis database
 *   UPSTASH_REDIS_REST_TOKEN – Read/write token for that database
 *
 * If either variable is absent (e.g. local dev without Redis), the module
 * falls back to the original in-memory implementation so the server still
 * starts. The fallback is logged once on first use and is not suitable for
 * production multi-instance deployments.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Redis-backed limiter (production path)
// ---------------------------------------------------------------------------

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  if (redisClient !== null) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redisClient = new Redis({ url, token });
  return redisClient;
}

// Cache Ratelimit instances keyed by "<limit>:<windowMs>" so we don't
// recreate them on every request.
const limiterCache = new Map<string, Ratelimit>();

function getLimiter(limit: number, windowMs: number): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const cacheKey = `${limit}:${windowMs}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
    // Prefix all keys in Redis with "dshield:" to avoid collision with other
    // applications sharing the same Upstash database.
    prefix: "dshield",
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev / no-Redis path)
// ---------------------------------------------------------------------------

const fallbackBuckets = new Map<string, { count: number; resetAt: number }>();
let fallbackWarned = false;

function checkFallback(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  if (!fallbackWarned) {
    console.warn(
      "[rateLimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not " +
        "set. Falling back to in-memory rate limiting — not suitable for " +
        "multi-instance deployments.",
    );
    fallbackWarned = true;
  }

  const now = Date.now();
  const bucket = fallbackBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    fallbackBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether `key` is within its rate limit.
 *
 * @param key       Unique identifier for the rate-limit bucket (e.g. "faucet:1.2.3.4")
 * @param limit     Maximum number of requests allowed per window
 * @param windowMs  Window duration in milliseconds
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const limiter = getLimiter(limit, windowMs);

  if (!limiter) {
    return checkFallback(key, limit, windowMs);
  }

  const { success, reset } = await limiter.limit(key);
  if (success) return { allowed: true, retryAfterSeconds: 0 };

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((reset - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSeconds };
}

/** Best-effort client identifier from standard proxy headers. */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") || "unknown";
}

// ---------------------------------------------------------------------------
// Test helpers — exported only for unit tests; not part of the public API.
// ---------------------------------------------------------------------------

/** @internal Reset in-memory fallback state between tests. */
export function _resetFallbackBuckets(): void {
  fallbackBuckets.clear();
  fallbackWarned = false;
}

/** @internal Flush the Ratelimit instance cache (needed when swapping Redis mocks). */
export function _resetLimiterCache(): void {
  limiterCache.clear();
  redisClient = null;
}
