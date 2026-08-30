import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNamespaceUpdate,
  create,
  get,
  getOccupancy,
  isCascadableDeleteError,
  list,
  remove,
  update,
  validateNamespaceName,
  NAMESPACE_NAME_MAX_LENGTH,
} from "./namespaces";

/* ================================================================== */
/*  validateNamespaceName (mirrors ^[a-zA-Z0-9][a-zA-Z0-9._-]*$)      */
/* ================================================================== */

describe("validateNamespaceName", () => {
  it("accepts simple names", () => {
    expect(validateNamespaceName("ferrum")).toBeNull();
    expect(validateNamespaceName("staging")).toBeNull();
    expect(validateNamespaceName("Team-A")).toBeNull();
  });

  it("accepts digits, dots, hyphens, and underscores after the first char", () => {
    expect(validateNamespaceName("ns1.prod_eu-west")).toBeNull();
    expect(validateNamespaceName("9lives")).toBeNull();
  });

  it("accepts a name exactly at the 254-character limit", () => {
    expect(validateNamespaceName("a".repeat(NAMESPACE_NAME_MAX_LENGTH))).toBeNull();
  });

  it("rejects the empty string", () => {
    expect(validateNamespaceName("")).toMatch(/required/);
  });

  it("rejects names longer than 254 characters", () => {
    expect(
      validateNamespaceName("a".repeat(NAMESPACE_NAME_MAX_LENGTH + 1)),
    ).toMatch(/254/);
  });

  it("rejects names starting with a separator", () => {
    expect(validateNamespaceName("-prod")).not.toBeNull();
    expect(validateNamespaceName(".prod")).not.toBeNull();
    expect(validateNamespaceName("_prod")).not.toBeNull();
  });

  it("rejects names with invalid characters", () => {
    expect(validateNamespaceName("my namespace")).not.toBeNull();
    expect(validateNamespaceName("prod/eu")).not.toBeNull();
    expect(validateNamespaceName("tenant@corp")).not.toBeNull();
    expect(validateNamespaceName("émeraude")).not.toBeNull();
  });
});

/* ================================================================== */
/*  buildNamespaceUpdate                                              */
/* ================================================================== */

describe("buildNamespaceUpdate", () => {
  it("returns null when nothing changed", () => {
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "QA tenant" },
        { name: "staging", description: "QA tenant" },
      ),
    ).toBeNull();
  });

  it("treats a missing current description as empty", () => {
    expect(
      buildNamespaceUpdate({ name: "staging" }, { name: "staging", description: "" }),
    ).toBeNull();
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: null },
        { name: "staging", description: "  " },
      ),
    ).toBeNull();
  });

  it("emits only the name on a pure rename", () => {
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "QA tenant" },
        { name: "qa", description: "QA tenant" },
      ),
    ).toEqual({ name: "qa" });
  });

  it("trims the new name and ignores a whitespace-only rename", () => {
    expect(
      buildNamespaceUpdate({ name: "staging" }, { name: "  qa  ", description: "" }),
    ).toEqual({ name: "qa" });
    expect(
      buildNamespaceUpdate({ name: "staging" }, { name: "   ", description: "" }),
    ).toBeNull();
  });

  it("emits only the description when it changes", () => {
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "old" },
        { name: "staging", description: "new" },
      ),
    ).toEqual({ description: "new" });
  });

  it("clears the description with null (never an empty string)", () => {
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "old" },
        { name: "staging", description: "" },
      ),
    ).toEqual({ description: null });
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "old" },
        { name: "staging", description: "   " },
      ),
    ).toEqual({ description: null });
  });

  it("emits both fields when both change", () => {
    expect(
      buildNamespaceUpdate(
        { name: "staging", description: "old" },
        { name: "qa", description: "new" },
      ),
    ).toEqual({ name: "qa", description: "new" });
  });

  it("never emits name: null (rejected by the gateway with 400)", () => {
    const payload = buildNamespaceUpdate(
      { name: "staging" },
      { name: "", description: "described" },
    );
    expect(payload).toEqual({ description: "described" });
    expect(payload && "name" in payload).toBe(false);
  });
});

/* ================================================================== */
/*  HTTP wiring (mocked fetch)                                        */
/* ================================================================== */

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

describe("namespace API requests", () => {
  const captured: CapturedRequest[] = [];
  let nextResponse: () => Response;

  // Node's Request rejects relative URLs; in the browser they resolve
  // against the page origin. Emulate that so the ky client's origin-relative
  // `/api/proxy` prefix works under vitest.
  class BasedRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && input.startsWith("/")) {
        input = new URL(input, "http://localhost").toString();
      }
      super(input, init);
    }
  }

  beforeEach(() => {
    captured.length = 0;
    nextResponse = () => new Response(JSON.stringify({}), { status: 200 });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request =
          input instanceof Request ? input : new Request(String(input));
        const text = await request.clone().text();
        captured.push({
          url: request.url,
          method: request.method,
          body: text ? JSON.parse(text) : undefined,
        });
        return nextResponse();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list() unwraps the paginated envelope of name strings", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: ["ferrum", "production", "staging"],
          pagination: { offset: 0, limit: 250, total: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(list()).resolves.toEqual(["ferrum", "production", "staging"]);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toContain(
      "/api/proxy/namespaces?offset=0&limit=250",
    );
  });

  it("list() follows every paginated namespace page", async () => {
    let call = 0;
    nextResponse = () => {
      call += 1;
      return new Response(
        JSON.stringify(
          call === 1
            ? {
                data: ["ferrum", "production"],
                pagination: { offset: 0, limit: 250, total: 3 },
              }
            : {
                data: ["staging"],
                pagination: { offset: 2, limit: 250, total: 3 },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(list()).resolves.toEqual(["ferrum", "production", "staging"]);
    expect(captured).toHaveLength(2);
    expect(captured[1].url).toContain("offset=2&limit=250");
  });

  it("list() passes through a bare array response", async () => {
    nextResponse = () =>
      new Response(JSON.stringify(["ferrum"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(list()).resolves.toEqual(["ferrum"]);
  });

  it("get() targets /namespaces/{name}", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: "staging",
          created_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const namespace = await get("staging");
    expect(namespace.name).toBe("staging");
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces\/staging$/);
  });

  it("create() POSTs the CreateNamespaceRequest body", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: "qa",
          description: "QA tenant",
          created_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:00:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );

    await create({ name: "qa", description: "QA tenant" });
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces$/);
    expect(captured[0].body).toEqual({ name: "qa", description: "QA tenant" });
  });

  it("update() PUTs the partial UpdateNamespaceRequest body", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: "quality",
          created_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await update("qa", { name: "quality" });
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces\/qa$/);
    expect(captured[0].body).toEqual({ name: "quality" });
  });

  it("remove() without confirm sends no query parameter", async () => {
    nextResponse = () => new Response(null, { status: 204 });

    await remove("qa");
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces\/qa$/);
    expect(captured[0].url).not.toContain("confirm");
  });

  it("remove() with confirm sends ?confirm=true for the cascade", async () => {
    nextResponse = () => new Response(null, { status: 204 });

    await remove("qa", { confirm: true });
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces\/qa\?confirm=true$/);
  });

  it("URL-encodes namespace names in paths", async () => {
    nextResponse = () => new Response(null, { status: 204 });

    // Not producible via the create form (validation rejects it), but the
    // API layer must never build a broken path from a hostile name.
    await remove("a/b");
    expect(captured[0].url).toMatch(/\/api\/proxy\/namespaces\/a%2Fb$/);
  });

  it("a description-only update never sends a name key", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          name: "qa",
          created_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const payload = buildNamespaceUpdate(
      { name: "qa", description: "old" },
      { name: "qa", description: "" },
    );
    await update("qa", payload!);
    expect(captured[0].body).toEqual({ description: null });
  });

  it("propagates HTTP errors (409 conflict) to the caller", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ error: "namespace already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });

    await expect(create({ name: "ferrum" })).rejects.toThrow();
  });
});

/* ================================================================== */
/*  isCascadableDeleteError                                           */
/* ================================================================== */

describe("isCascadableDeleteError", () => {
  const occupancy = JSON.stringify({
    error: 'namespace "qa" still has resources; pass confirm=true to cascade-delete',
  });
  const protectedNs = JSON.stringify({
    error:
      "cannot delete a namespace this gateway is configured to serve (FERRUM_NAMESPACE / FERRUM_CP_NAMESPACES)",
  });
  const lastRow = JSON.stringify({
    error: "cannot delete the last remaining namespace registry row",
  });

  it("treats an occupancy 409 as cascadable", () => {
    expect(isCascadableDeleteError(409, occupancy)).toBe(true);
  });

  it("does not offer a cascade for a protected namespace", () => {
    // A cascade cannot fix this — offering it walks the user into a 2nd 409.
    expect(isCascadableDeleteError(409, protectedNs)).toBe(false);
  });

  it("does not offer a cascade for the last remaining registry row", () => {
    expect(isCascadableDeleteError(409, lastRow)).toBe(false);
  });

  it("matches the protected reason regardless of case", () => {
    expect(
      isCascadableDeleteError(409, "blocked by ferrum_cp_namespaces"),
    ).toBe(false);
  });

  it("ignores non-409 statuses", () => {
    expect(isCascadableDeleteError(404, occupancy)).toBe(false);
    expect(isCascadableDeleteError(403, occupancy)).toBe(false);
    expect(isCascadableDeleteError(503, occupancy)).toBe(false);
  });
});

/* ================================================================== */
/*  getOccupancy                                                      */
/* ================================================================== */

describe("getOccupancy", () => {
  const captured: CapturedRequest[] = [];

  class BasedRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && input.startsWith("/")) {
        input = new URL(input, "http://localhost").toString();
      }
      super(input, init);
    }
  }

  const stub = (responder: (url: string) => Response) => {
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request =
          input instanceof Request ? input : new Request(String(input));
        captured.push({
          url: request.url,
          method: request.method,
          body: request.headers.get("X-Ferrum-Namespace"),
        });
        return responder(request.url);
      }),
    );
  };

  const paginated = (total: number) =>
    new Response(
      JSON.stringify({ data: [], pagination: { offset: 0, limit: 1, total } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  beforeEach(() => {
    captured.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sums totals and reports only non-empty kinds", async () => {
    stub((url) => {
      if (url.includes("/proxies")) return paginated(12);
      if (url.includes("/consumers")) return paginated(4);
      return paginated(0);
    });

    const result = await getOccupancy("qa");

    expect(result.total).toBe(16);
    expect(result.partial).toBe(false);
    expect(result.entries).toEqual([
      { label: "proxies", count: 12 },
      { label: "consumers", count: 4 },
    ]);
  });

  it("pins every count to the target namespace, not the active one", async () => {
    stub(() => paginated(0));

    await getOccupancy("other-tenant");

    expect(captured).toHaveLength(5);
    // `body` carries the X-Ferrum-Namespace header for this suite.
    expect(captured.map((r) => r.body)).toEqual(
      Array(5).fill("other-tenant"),
    );
  });

  it("requests only one row per kind — totals come from pagination", async () => {
    stub(() => paginated(9999));

    await getOccupancy("qa");

    expect(captured.every((r) => r.url.includes("limit=1"))).toBe(true);
  });

  it("marks the result partial when a kind cannot be counted", async () => {
    stub((url) =>
      url.includes("/api-specs")
        ? new Response(JSON.stringify({ error: "not found" }), { status: 404 })
        : paginated(2),
    );

    const result = await getOccupancy("qa");

    // api-specs legitimately 404s on gateways without the feature; it must
    // count as uncountable rather than as zero, so the UI can say so.
    expect(result.partial).toBe(true);
    expect(result.total).toBe(8);
  });

  it("does not treat an uncountable kind as empty", async () => {
    stub(() =>
      new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    );

    const result = await getOccupancy("qa");

    expect(result.partial).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });
});
