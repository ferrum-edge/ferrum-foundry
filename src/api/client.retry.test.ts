import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, proxyApi } from "./client";
import { deleteCredentialByIndex, get as getConsumer } from "./consumers";
import { resetGatewayMetadata } from "./gatewayMetadata";

// Match browser URL resolution while keeping the real configured ky clients.
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = new URL(input, "http://localhost").toString();
    }
    super(input, init);
  }
}

function committedResponse(): Response {
  return new Response(
    JSON.stringify({ applied: false, reason: "runtime_rejected" }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-ferrum-config-cursor": "4:9",
        "retry-after": "0",
      },
    },
  );
}

describe("configured client retry policy", () => {
  const captured: Request[] = [];
  let respond: (request: Request) => Response;

  beforeEach(() => {
    captured.length = 0;
    // Isolate cursor monitoring; these assertions count the originating call.
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        captured.push(request.clone());
        return respond(request);
      }),
    );
  });

  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("sends a committed 503 PUT exactly once despite Retry-After", async () => {
    respond = committedResponse;

    await expect(
      api.put("api/proxy/proxies/orders", { json: { id: "orders" } }),
    ).rejects.toMatchObject({
      response: { status: 503 },
      data: { applied: false, reason: "runtime_rejected" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("PUT");
  });

  it("leaves the other rotation entry intact after an ambiguous 502 DELETE", async () => {
    const credentials = [{ key: "old-key" }, { key: "new-key" }];
    const deleted: typeof credentials = [];
    respond = (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") {
        expect(path).toBe("/api/proxy/consumers/alice/credentials/keyauth/0");
        deleted.push(...credentials.splice(0, 1));
        return new Response("upstream response lost", { status: 502 });
      }
      expect(request.method).toBe("GET");
      expect(path).toBe("/api/proxy/consumers/alice");
      return Response.json({ id: "alice", credentials: { keyauth: credentials } });
    };

    await expect(
      deleteCredentialByIndex("alice", "keyauth", 0),
    ).rejects.toMatchObject({ response: { status: 502 } });

    expect(captured).toHaveLength(1);
    expect(deleted).toEqual([{ key: "old-key" }]);
    expect(credentials).toEqual([{ key: "new-key" }]);

    // A deliberate re-check reads the committed state without repeating DELETE.
    const current = await getConsumer("alice");
    expect(current.credentials.keyauth).toEqual([{ key: "new-key" }]);
    expect(captured.map((request) => request.method)).toEqual(["DELETE", "GET"]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "does not retry a %s with Retry-After even without a commit cursor",
    async (method) => {
      respond = () =>
        new Response("unavailable", {
          status: 503,
          headers: { "retry-after": "0" },
        });

      await expect(
        proxyApi("consumers/alice", { method }),
      ).rejects.toMatchObject({ response: { status: 503 } });
      expect(captured).toHaveLength(1);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "surfaces an ambiguous %s network failure without replay",
    async (method) => {
      respond = () => {
        throw new TypeError("Failed to fetch");
      };

      await expect(proxyApi("consumers/alice", { method })).rejects.toThrow();
      expect(captured).toHaveLength(1);
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"])(
    "bounds %s 503 retries at two, including Retry-After",
    async (method) => {
      respond = () =>
        new Response(null, {
          status: 503,
          headers: { "retry-after": "0" },
        });

      await expect(
        proxyApi("consumers/alice", { method }),
      ).rejects.toMatchObject({ response: { status: 503 } });
      expect(captured).toHaveLength(3);
      expect(captured.every((request) => request.method === method)).toBe(true);
    },
  );

  it("returns a successful GET after a transient 503", async () => {
    respond = () =>
      captured.length === 1
        ? new Response(null, { status: 503, headers: { "retry-after": "0" } })
        : Response.json({ id: "alice" });

    await expect(proxyApi.get("consumers/alice").json()).resolves.toEqual({
      id: "alice",
    });
    expect(captured).toHaveLength(2);
  });

  it("never retries a committed-but-not-live response even on a GET", async () => {
    respond = committedResponse;

    await expect(proxyApi.get("consumers/alice")).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(captured).toHaveLength(1);
  });
});
