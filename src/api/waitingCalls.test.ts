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
      return delayedResponse({ state: polls < 4 ? "pending" : "applied" }, 25_000);
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
