import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NativeRequest = Request;
class BasedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

function delayedResponse(body: unknown, delay: number): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(Response.json(body)), delay);
  });
}

describe("configured client server-side waiting calls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("Request", BasedRequest);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("accepts several full 25-second pending polls before reporting applied", async () => {
    let polls = 0;
    const fetcher = vi.fn((request: Request) => {
      expect(new URL(request.url).searchParams.get("wait_ms")).toBe("25000");
      polls += 1;
      return delayedResponse({
        state: polls < 4 ? "pending" : "applied",
        topology_epoch: "1", sequence: "9",
        accepted_topology_epoch: "1", accepted_sequence: polls < 4 ? "8" : "9",
      }, 25_000);
    });
    vi.stubGlobal("fetch", fetcher);
    await import("./client");
    const metadata = await import("./gatewayMetadata");
    const reasons: Array<string | null> = [];
    const unsubscribe = metadata.subscribeGatewayMetadata(() => {
      reasons.push(metadata.getGatewayMetadataSnapshot().apply.reason);
    });
    await metadata.observeGatewayResponse(
      new Request("http://localhost/api/proxy/proxies", { method: "POST" }),
      new Response(null, { status: 202, headers: { "X-Ferrum-Config-Cursor": "1:9" } }),
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(metadata.getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "pending",
      polling: true,
    });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(metadata.getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "applied",
      polling: false,
      reason: null,
    });
    expect(reasons).not.toContain("apply_status_unavailable");
    unsubscribe();
    metadata.resetGatewayMetadata();
  });

  it("accepts an eleven-second backup without replaying the export", async () => {
    const fetcher = vi.fn(() => delayedResponse({ version: "1", proxies: [] }, 11_000));
    vi.stubGlobal("fetch", fetcher);
    const { getBackup } = await import("./ops");
    const result = getBackup({ namespace: "default" }, ["proxies"]);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(result).resolves.toMatchObject({ version: "1", proxies: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds backup at 120 seconds without retrying an unknown export", async () => {
    const fetcher = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason));
    }));
    vi.stubGlobal("fetch", fetcher);
    const { getBackup } = await import("./ops");
    const result = getBackup({ namespace: "default" }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetcher.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).name).toBe("TimeoutError");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not automatically repeat a failed backup GET", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "busy" }, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { getBackup } = await import("./ops");
    await expect(getBackup({ namespace: "default" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts an ACME finalization after the old ten-second deadline", async () => {
    const fetcher = vi.fn(() => delayedResponse({ order: { status: "valid" } }, 15_000));
    vi.stubGlobal("fetch", fetcher);
    const { finalizeAcmeOrder } = await import("./tls");
    const result = finalizeAcmeOrder("order");
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toMatchObject({ order: { status: "valid" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([60, 600])("bounds a %s-second wait and re-checks without a second POST", async (seconds) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn((request: Request) => {
      // ky consumes the request body it hands to fetch; keep a readable copy.
      requests.push(request.clone());
      if (request.method === "GET") return Promise.resolve(Response.json({ status: "processing" }));
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    }));
    const { finalizeAcmeOrder, getAcmeOrder, AcmeFinalizationUnknownError } = await import("./tls");
    const result = finalizeAcmeOrder("order", { poll_timeout_seconds: seconds }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(seconds * 1000 + 4_999);
    expect(requests[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(AcmeFinalizationUnknownError);
    expect(error.message).toMatch(/in progress.*unknown.*Re-check/);
    await expect(getAcmeOrder("order")).resolves.toMatchObject({ status: "processing" });
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(await requests[0].json()).toMatchObject({ poll_timeout_seconds: seconds });
  });

  it.each([502, 504])("treats a deployment HTTP %s interruption as unknown", async (status) => {
    const fetcher = vi.fn(async () => Response.json({ error: "deadline" }, { status }));
    vi.stubGlobal("fetch", fetcher);
    const { finalizeAcmeOrder, AcmeFinalizationUnknownError } = await import("./tls");
    await expect(finalizeAcmeOrder("order")).rejects.toBeInstanceOf(AcmeFinalizationUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not replay finalization after a network disconnect", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetcher);
    const { finalizeAcmeOrder, AcmeFinalizationUnknownError } = await import("./tls");
    await expect(finalizeAcmeOrder("order")).rejects.toBeInstanceOf(AcmeFinalizationUnknownError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([0, 601, 1.5, Number.NaN])("rejects an invalid budget %s before posting", async (seconds) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { finalizeAcmeOrder } = await import("./tls");
    await expect(finalizeAcmeOrder("order", { poll_timeout_seconds: seconds })).rejects.toThrow(
      "ACME polling budget must be an integer from 1 to 600 seconds.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// Exercise real ky deadlines so accidentally omitting an option fails at 10 s.
describe('spec and ACME mutation deadlines', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('Request', BasedRequest);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function invoke(operation: string) {
    const specs = await import('./apiSpecs');
    const tls = await import('./tls');
    const scope = { namespace: 'default' };
    switch (operation) {
      case 'import': return specs.create(scope, '{}');
      case 'replace': return specs.update(scope, 'fixture', '{}');
      case 'document': return specs.getDocument(scope, 'fixture');
      case 'create': return tls.createAcmeOrder({
        domains: ['example.test'], directory_url: 'https://ca.example.test/directory',
      });
      default: return tls.renewAcmeCertificate('fixture');
    }
  }

  it.each([
    ['import', 365_000],
    ['replace', 365_000],
    ['document', 65_000],
    ['create', 125_000],
    ['renew', 125_000],
  ] as const)('allows the full BFF budget for %s without replay', async (operation, timeout) => {
    const fetcher = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    }));
    vi.stubGlobal('fetch', fetcher);
    // Load modules before advancing virtual time.
    await import('./apiSpecs');
    await import('./tls');
    const result = invoke(operation).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe(
      operation === 'document' ? 'TimeoutError' : 'MutationOutcomeUnknownError',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['import', 'replace', 'create', 'renew'])(
    'distinguishes upload rejection from an uncertain %s response',
    async (operation) => {
      const fetcher = vi.fn(async () => Response.json({
        code: 'FERRUM_BFF_TIMEOUT', phase: 'upload',
      }, { status: 504 }));
      vi.stubGlobal('fetch', fetcher);
      await expect(invoke(operation)).rejects.toMatchObject({ name: 'HTTPError' });
      fetcher.mockImplementation(async () => Response.json({
        code: 'FERRUM_BFF_TIMEOUT', phase: 'response',
      }, { status: 504 }));
      await expect(invoke(operation)).rejects.toMatchObject({
        name: 'MutationOutcomeUnknownError',
        message: expect.stringContaining('outcome unknown'),
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
