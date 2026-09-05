import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, remove, update, type GatewayTrustBundleCreate } from "./trust";

describe("gateway trust mutation wiring", () => {
  const captured: Array<{
    url: string;
    method: string;
    namespace: string | null;
    body: unknown;
  }> = [];
  class BasedRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && input.startsWith("/")) {
        input = new URL(input, "http://localhost").toString();
      }
      super(input, init);
    }
  }
  const payload: GatewayTrustBundleCreate = {
    id: "trust-1",
    trust_domain: "example.org",
    revision: 77,
    bundle: {
      local: { trust_domain: "example.org", x509_authorities: ["AQID"] },
    },
  };

  beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const outgoing = input instanceof Request ? input : new Request(String(input));
        const text = await outgoing.clone().text();
        captured.push({
          url: outgoing.url,
          method: outgoing.method,
          namespace: outgoing.headers.get("x-ferrum-namespace"),
          body: text ? JSON.parse(text) : undefined,
        });
        return new Response(
          JSON.stringify({
            ...payload,
            namespace: "production",
            revision: 78,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("pins namespace and preserves the optimistic revision on update", async () => {
    const scope = { namespace: "production" };
    await create(scope, { ...payload, revision: undefined });
    await update(scope, "trust-1", payload);
    await remove(scope, "trust-1");

    expect(captured.map(({ method }) => method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(captured.every(({ namespace }) => namespace === "production")).toBe(true);
    expect(captured[1].body).toMatchObject({ revision: 77, trust_domain: "example.org" });
    expect(captured[1].url).toMatch(/\/gateway-trust-bundles\/trust-1$/);
  });
});
