import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNamespaceUpdate,
  create,
  get,
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
          pagination: { offset: 0, limit: 1000, total: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(list()).resolves.toEqual(["ferrum", "production", "staging"]);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toContain("/api/proxy/namespaces?limit=1000");
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
