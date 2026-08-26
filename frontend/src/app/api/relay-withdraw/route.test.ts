import { describe, it, expect, vi, afterEach } from "vitest";

const VALID_G = "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";
const VALID_C = "CDYZE3XQZA2UYUTYEEVLOKSYDD44CQZ6LYJIKQEDIUYBXNVSNXEQVGEG";

async function loadRoute(secret?: string) {
  vi.resetModules();
  if (secret === undefined) delete process.env.RELAYER_SECRET;
  else process.env.RELAYER_SECRET = secret;
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; September 2015";
  return (await import("./route")).POST;
}

const req = (body: unknown, ip = "1.2.3.4") =>
  ({
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? ip : null) },
  }) as never;

const base = {
  poolId: VALID_C,
  recipient: VALID_G,
  publicInputs: "00",
  proof: "00",
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("/api/relay-withdraw validation", () => {
  it("503 when the relayer secret is not configured", async () => {
    const POST = await loadRoute(undefined);
    const res = await POST(req(base));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("no_relayer");
  });

  it("400 on an invalid pool id", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ ...base, poolId: "not-a-contract" }));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid recipient address", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ ...base, recipient: "nope" }));
    expect(res.status).toBe(400);
  });

  it("400 when publicInputs/proof are not hex", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ ...base, publicInputs: "zz", proof: "00" }));
    expect(res.status).toBe(400);
  });
});

describe("/api/relay-withdraw rate limiting", () => {
  it("429s when checkRateLimit returns not-allowed (mocked Redis)", async () => {
    // Use vi.doMock so the mock is not hoisted — it applies to the dynamic
    // import below. Simulates a distributed Redis counter being exhausted:
    // the 429 is returned regardless of which instance handles the request.
    vi.resetModules();
    vi.doMock("@/lib/rateLimit", () => ({
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 120,
      }),
      clientKey: vi.fn().mockReturnValue("9.9.9.9"),
    }));
    process.env.RELAYER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; September 2015";
    const { POST } = await import("./route");

    const res = await POST(req(base));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
  });

  it("allows a request when checkRateLimit returns allowed", async () => {
    vi.resetModules();
    vi.doMock("@/lib/rateLimit", () => ({
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        retryAfterSeconds: 0,
      }),
      clientKey: vi.fn().mockReturnValue("9.9.9.9"),
    }));
    process.env.RELAYER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; September 2015";
    const { POST } = await import("./route");

    // Request will fail at validation (invalid poolId), but not with 429.
    const res = await POST(req({ ...base, poolId: "not-a-contract" }));
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(429);
  });

  it("does not rate-limit a different IP (independent keys in Redis)", async () => {
    vi.resetModules();
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
    process.env.RELAYER_SECRET = "Sxxx-dummy-secret";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; September 2015";
    const { POST } = await import("./route");

    const blocked = await POST(req(base, "9.9.9.9"));
    expect(blocked.status).toBe(429);

    const allowed = await POST(req({ ...base, poolId: "not-a-contract" }, "7.7.7.7"));
    expect(allowed.status).toBe(400); // not 429
  });
});
