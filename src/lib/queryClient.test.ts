import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, scoped, SILENT_ERRORS } from "@/api/client";
import { resetGatewayMetadata } from "@/api/gatewayMetadata";
import { createQueryClient } from "./queryClient";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

const scope = { namespace: "ferrum" };
const silently = { context: { [SILENT_ERRORS]: true } };

describe("the application query client", () => {
  let status: number;
  let writes: number;
  let answer: { body: unknown; headers: Record<string, string> };

  beforeEach(() => {
    writes = 0;
    answer = { body: { error: "Bad Gateway", code: "FERRUM_BFF_UPSTREAM_FAILURE" }, headers: {} };
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method !== "GET") writes += 1;
      return Response.json(answer.body, { status, headers: answer.headers });
    }));
  });

  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  async function failWrite() {
    const client = createQueryClient();
    client.setQueryData(["ferrum", "upstreams"], []);
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => api.post("api/proxy/upstreams", scoped(scope, { json: {}, ...silently })).json(),
    });
    await mutation.execute(undefined).catch(() => undefined);
    return client;
  }

  it("refreshes cached reads after a write whose outcome is unknown, without replaying it", async () => {
    status = 502;
    const client = await failWrite();
    expect(writes).toBe(1);
    expect(client.getQueryState(["ferrum", "upstreams"])?.isInvalidated).toBe(true);
  });

  it("refreshes cached reads after a committed-but-not-live write, without replaying it", async () => {
    status = 503;
    answer = {
      body: { error: "reload timed out", applied: false, reason: "reload_timeout" },
      headers: { "x-ferrum-config-cursor": "1:2" },
    };
    const client = await failWrite();
    expect(writes).toBe(1);
    expect(client.getQueryState(["ferrum", "upstreams"])?.isInvalidated).toBe(true);
  });

  it("leaves cached reads alone after a 503 that applied nothing", async () => {
    status = 503;
    answer = { body: { error: "retry later" }, headers: { "Retry-After": "1" } };
    const client = await failWrite();
    expect(writes).toBe(1);
    expect(client.getQueryState(["ferrum", "upstreams"])?.isInvalidated).toBe(false);
  });

  it("leaves cached reads alone after a definite rejection", async () => {
    status = 409;
    const client = await failWrite();
    expect(writes).toBe(1);
    expect(client.getQueryState(["ferrum", "upstreams"])?.isInvalidated).toBe(false);
  });
});
