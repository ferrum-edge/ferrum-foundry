import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiErrorHandler, setOnUnauthorized } from "./client";
import { getOverload } from "./ops";
import { resetGatewayMetadata } from "./gatewayMetadata";

const NativeRequest = Request;
class BasedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

const scope = { namespace: "ferrum" };

describe("overload response classification", () => {
  const report = vi.fn();
  const unauthorized = vi.fn();
  const fetcher = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal("fetch", fetcher);
    setApiErrorHandler(report);
    setOnUnauthorized(unauthorized);
  });

  afterEach(() => {
    setApiErrorHandler(undefined);
    setOnUnauthorized(undefined);
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it.each<[number, string]>([
    [200, "normal"], [200, "pressure"], [503, "critical"],
  ])("accepts a %s %s snapshot without a global error", async (status, level) => {
    const body = { level, draining: true };
    fetcher.mockImplementation(async (request: Request) => {
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("ferrum");
      return Response.json(body, { status: Number(status) });
    });
    await expect(getOverload(scope)).resolves.toEqual(body);
    expect(report).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each<[number, string]>([
    [503, ""], [500, ""], [503, JSON.stringify({ error: "gateway down" })],
    [503, JSON.stringify({ level: "normal" })], [200, "not json"],
    [401, JSON.stringify({ error: "unauthorized" })],
  ])("rejects and reports a non-snapshot %s response once (%#)", async (status, body) => {
    fetcher.mockImplementation(async () => new Response(body, { status }));
    await expect(getOverload(scope)).rejects.toThrow("without a valid snapshot");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ statusCode: status, body }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves BFF session expiry handling", async () => {
    fetcher.mockImplementation(async () => new Response("expired", {
      status: 401, headers: { "X-Ferrum-Auth-Layer": "bff" },
    }));
    await expect(getOverload(scope)).rejects.toThrow();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports an exhausted network failure once and rejects", async () => {
    fetcher.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getOverload(scope)).rejects.toThrow("Failed to fetch");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 0, body: "Failed to fetch",
    }));
  });
});
