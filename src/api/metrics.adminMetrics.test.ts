import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminMetricsRequestStart } from "./adminMetricsTiming";
import { setApiErrorHandler } from "./client";
import { resetGatewayMetadata } from "./gatewayMetadata";
import { getAdminMetrics } from "./metrics";

const NativeRequest = Request;
class BasedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

const scope = { namespace: "ferrum" };
const body = { gateway: { mode: "dp", uptime_seconds: 10, total_requests: 5 } };

describe("getAdminMetrics", () => {
  const fetcher = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal("fetch", fetcher);
    setApiErrorHandler(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    setApiErrorHandler(undefined);
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("records when the request was sent, not when it resolved", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    fetcher.mockImplementation(async () => {
      vi.setSystemTime(4_000);
      return Response.json(body);
    });
    const metrics = await getAdminMetrics(scope);
    expect(Date.now()).toBe(4_000);
    expect(adminMetricsRequestStart(metrics.gateway)).toBe(1_000);
  });

  it("forwards the query's abort signal", async () => {
    const controller = new AbortController();
    let abortedOnTheWire: boolean | undefined;
    fetcher.mockImplementation(async (request: Request) => {
      controller.abort();
      abortedOnTheWire = request.signal.aborted;
      return Response.json(body);
    });
    await getAdminMetrics(scope, controller.signal).catch(() => undefined);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(abortedOnTheWire).toBe(true);
  });
});
