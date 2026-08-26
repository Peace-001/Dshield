import { describe, it, expect, vi, afterEach } from "vitest";

const VALID_G = "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";

// The route reads USDC_ISSUER_SECRET at module load, so reload per scenario.
async function loadRoute(secret?: string) {
  vi.resetModules();
  if (secret === undefined) delete process.env.USDC_ISSUER_SECRET;
  else process.env.USDC_ISSUER_SECRET = secret;
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
  process.env.NEXT_PUBLIC_USDC_CODE = "USDC";
  return (await import("./route")).POST;
}

// Minimal NextRequest stand-in — the handler calls req.json() and
// req.headers.get(...) (for rate-limit keying).
const req = (body: unknown, ip = "1.2.3.4") =>
  ({
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? ip : null) },
  }) as never;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("/api/faucet validation", () => {
  it("503 when the issuer secret is not configured", async () => {
    const POST = await loadRoute(undefined);
    const res = await POST(req({ address: VALID_G, amount: "1" }));
    expect(res.status).toBe(503);
  });

  it("400 on an invalid recipient address", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ address: "not-an-address", amount: "1" }));
    expect(res.status).toBe(400);
  });

  it("400 on a non-positive amount", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ address: VALID_G, amount: "0" }));
    expect(res.status).toBe(400);
  });
});

describe("/api/faucet rate limiting", () => {
  it("429s when checkRateLimit returns not-allowed (mocked Redis)", async () => {
    // Use vi.doMock (not vi.mock) so the mock is not hoisted and is applied
    // before the dynamic import below. This simulates a distributed Redis
    // counter being exhausted — regardless of which serverless instance
    // handles the request, the 429 is returned.
    vi.resetModules();
    vi.doMock("@/lib/rateLimit", () => ({
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 42,
      }),
      clientKey: vi.fn().mockReturnValue("5.5.5.5"),
    }));
    process.env.USDC_ISSUER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
    process.env.NEXT_PUBLIC_USDC_CODE = "USDC";
    const { POST } = await import("./route");

    const res = await POST(req({ address: VALID_G, amount: "1" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
  });

  it("allows a request when checkRateLimit returns allowed", async () => {
    vi.resetModules();
    vi.doMock("@/lib/rateLimit", () => ({
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        retryAfterSeconds: 0,
      }),
      clientKey: vi.fn().mockReturnValue("5.5.5.5"),
    }));
    process.env.USDC_ISSUER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
    process.env.NEXT_PUBLIC_USDC_CODE = "USDC";
    const { POST } = await import("./route");

    // The request will fail later (invalid address), but NOT with 429.
    const res = await POST(req({ address: "not-an-address", amount: "1" }));
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(429);
  });

  it("does not rate-limit a different IP (independent keys in Redis)", async () => {
    vi.resetModules();
    // Simulate: key containing "9.9.9.9" is exhausted; key for "7.7.7.7" is fine.
    vi.doMock("@/lib/rateLimit", () => ({
      checkRateLimit: vi.fn().mockImplementation(async (key: string) => {
        if (key.includes("9.9.9.9")) {
          return { allowed: false, retryAfterSeconds: 60 };
        }
        return { allowed: true, retryAfterSeconds: 0 };
      }),
      clientKey: vi.fn().mockImplementation((headers: { get: (k: string) => string | null }) =>
        headers.get("x-forwarded-for") ?? "unknown",
      ),
    }));
    process.env.USDC_ISSUER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
    process.env.NEXT_PUBLIC_USDC_CODE = "USDC";
    const { POST } = await import("./route");

    const blocked = await POST(req({ address: VALID_G, amount: "1" }, "9.9.9.9"));
    expect(blocked.status).toBe(429);

    const allowed = await POST(req({ address: "not-an-address", amount: "1" }, "7.7.7.7"));
    expect(allowed.status).toBe(400); // not 429
  });
});
