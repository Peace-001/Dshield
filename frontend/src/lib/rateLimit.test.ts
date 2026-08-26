/**
 * Unit tests for frontend/src/lib/rateLimit.ts
 *
 * Two scenarios are tested:
 *   1. Redis-backed path  – verifies durable, cross-instance behaviour by
 *      injecting a mock Redis/Ratelimit that simulates a shared counter.
 *   2. In-memory fallback – verifies graceful degradation when Upstash env
 *      vars are absent.
 *
 * The cross-instance durability contract is validated by:
 *   • Simulating two different "instances" calling checkRateLimit with the
 *     same key against the same (mocked) shared counter.
 *   • Confirming that the limit is enforced even after a simulated redeploy
 *     (module re-import + cache flush) as long as the mock counter persists.
 *
 * NOTE: We use vi.doMock (not vi.mock) throughout so that mocks are NOT
 * hoisted and can reference variables defined in the test body.
 * Both Ratelimit and Redis mocks must use `function` syntax (not arrow
 * functions) because the production code instantiates them with `new`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RateLimitModule = typeof import("./rateLimit");

/** Re-import rateLimit with clean module + env state. */
async function loadModule(env: { url?: string; token?: string } = {}): Promise<RateLimitModule> {
  vi.resetModules();
  if (env.url) process.env.UPSTASH_REDIS_REST_URL = env.url;
  else delete process.env.UPSTASH_REDIS_REST_URL;
  if (env.token) process.env.UPSTASH_REDIS_REST_TOKEN = env.token;
  else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return import("./rateLimit");
}

// ---------------------------------------------------------------------------
// Shared counter factory
// ---------------------------------------------------------------------------

/**
 * Build a shared counter that survives module resets, simulating external
 * Redis state that persists across redeploys / different serverless instances.
 *
 * Both Ratelimit and Redis must be `function` constructors (not arrow
 * functions) because the production code calls them with `new`.
 */
function buildSharedCounter(limit: number) {
  const counts = new Map<string, number>();

  const mockLimitFn = vi.fn(async (key: string) => {
    const current = counts.get(key) ?? 0;
    const next = current + 1;
    counts.set(key, next);
    const allowed = next <= limit;
    return {
      success: allowed,
      limit,
      remaining: Math.max(0, limit - next),
      reset: Date.now() + 60_000,
    };
  });

  // Use a real `function` (not arrow) so `new MockRatelimitClass()` works.
  const limitRef = mockLimitFn;
  const slidingWindowFn = vi.fn().mockReturnValue({ type: "slidingWindow" });

  function MockRatelimitClass(_opts: unknown) {
    // @ts-expect-error intentional constructor mock
    this.limit = limitRef;
  }
  MockRatelimitClass.slidingWindow = slidingWindowFn;

  // Same for Redis — must be constructable.
  function MockRedis(_opts: unknown) {}

  return { MockRatelimitClass, MockRedis, mockLimitFn, slidingWindowFn, counts };
}

// ---------------------------------------------------------------------------
// Redis-backed tests
// ---------------------------------------------------------------------------

describe("checkRateLimit — Redis-backed (cross-instance durability)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("allows requests up to the limit using a shared Redis counter", async () => {
    const LIMIT = 3;
    const { MockRatelimitClass, MockRedis, mockLimitFn } = buildSharedCounter(LIMIT);

    vi.doMock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitClass }));
    vi.doMock("@upstash/redis", () => ({ Redis: MockRedis }));

    const mod = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    mod._resetLimiterCache();

    for (let i = 0; i < LIMIT; i++) {
      const result = await mod.checkRateLimit("test-key", LIMIT, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBe(0);
    }

    expect(mockLimitFn).toHaveBeenCalledTimes(LIMIT);
  });

  it("blocks requests once the shared counter exceeds the limit", async () => {
    const LIMIT = 2;
    const { MockRatelimitClass, MockRedis } = buildSharedCounter(LIMIT);

    vi.doMock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitClass }));
    vi.doMock("@upstash/redis", () => ({ Redis: MockRedis }));

    const mod = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    mod._resetLimiterCache();

    for (let i = 0; i < LIMIT; i++) {
      await mod.checkRateLimit("shared-key", LIMIT, 60_000);
    }

    const blocked = await mod.checkRateLimit("shared-key", LIMIT, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("simulates cross-instance durability: a second 'instance' sees the exhausted counter", async () => {
    const LIMIT = 2;
    // The shared counter Map persists across module resets in this closure —
    // this is the key property that represents Redis surviving a redeploy.
    const { MockRatelimitClass, MockRedis, counts } = buildSharedCounter(LIMIT);

    vi.doMock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitClass }));
    vi.doMock("@upstash/redis", () => ({ Redis: MockRedis }));

    // --- Instance A exhausts the limit ---
    const modA = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    modA._resetLimiterCache();

    for (let i = 0; i < LIMIT; i++) {
      await modA.checkRateLimit("user-ip", LIMIT, 60_000);
    }
    expect(counts.get("user-ip")).toBe(LIMIT);

    // --- Simulate Instance B: fresh module import, same shared counter ---
    vi.resetModules(); // clear module registry only; doMock registrations remain
    const modB = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    modB._resetLimiterCache();

    const result = await modB.checkRateLimit("user-ip", LIMIT, 60_000);
    expect(result.allowed).toBe(false);
  });

  it("does not rate-limit a different key even when another key is exhausted", async () => {
    const LIMIT = 1;
    const { MockRatelimitClass, MockRedis } = buildSharedCounter(LIMIT);

    vi.doMock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitClass }));
    vi.doMock("@upstash/redis", () => ({ Redis: MockRedis }));

    const mod = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    mod._resetLimiterCache();

    // Exhaust key A
    await mod.checkRateLimit("keyA", LIMIT, 60_000);
    const blockedA = await mod.checkRateLimit("keyA", LIMIT, 60_000);
    expect(blockedA.allowed).toBe(false);

    // Key B has its own independent counter
    const allowedB = await mod.checkRateLimit("keyB", LIMIT, 60_000);
    expect(allowedB.allowed).toBe(true);
  });

  it("uses slidingWindow algorithm (verifies Ratelimit construction)", async () => {
    const LIMIT = 5;
    const { MockRatelimitClass, MockRedis, slidingWindowFn } = buildSharedCounter(LIMIT);

    vi.doMock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitClass }));
    vi.doMock("@upstash/redis", () => ({ Redis: MockRedis }));

    const mod = await loadModule({ url: "https://fake.upstash.io", token: "fake-token" });
    mod._resetLimiterCache();

    await mod.checkRateLimit("some-key", LIMIT, 30_000);

    expect(slidingWindowFn).toHaveBeenCalledWith(LIMIT, "30000 ms");
  });
});

// ---------------------------------------------------------------------------
// In-memory fallback tests
// ---------------------------------------------------------------------------

describe("checkRateLimit — in-memory fallback (no Redis env vars)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("allows requests up to the limit", async () => {
    const mod = await loadModule();
    mod._resetFallbackBuckets();

    for (let i = 0; i < 3; i++) {
      const r = await mod.checkRateLimit("fallback-key", 3, 60_000);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks requests once the limit is exceeded", async () => {
    const mod = await loadModule();
    mod._resetFallbackBuckets();

    for (let i = 0; i < 3; i++) {
      await mod.checkRateLimit("fb-key", 3, 60_000);
    }
    const r = await mod.checkRateLimit("fb-key", 3, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("does not rate-limit a different key", async () => {
    const mod = await loadModule();
    mod._resetFallbackBuckets();

    for (let i = 0; i < 3; i++) {
      await mod.checkRateLimit("ip-a", 3, 60_000);
    }
    const r = await mod.checkRateLimit("ip-b", 3, 60_000);
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clientKey tests
// ---------------------------------------------------------------------------

describe("clientKey", () => {
  it("extracts the first IP from x-forwarded-for", async () => {
    const { clientKey } = await loadModule();
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(clientKey(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", async () => {
    const { clientKey } = await loadModule();
    const headers = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(clientKey(headers)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no headers present", async () => {
    const { clientKey } = await loadModule();
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
