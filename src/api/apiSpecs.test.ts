import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHTTPError } from "ky";
import * as specs from "./apiSpecs";
import { getApiErrorDetail, setApiErrorHandler, setCsrfToken } from "./client";
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import { BasedRequest } from "@/test/__tests__/harness";

const scope = { namespace: "tenant-a" };
const summary: specs.ApiSpecSummary = {
  id: "orders-spec", proxy_id: "orders", namespace: "tenant-a", spec_version: "3.1.0",
  spec_format: "yaml", title: "Orders", info_version: "1.0", description: null,
  contact_name: null, contact_email: null, license_name: null, license_identifier: null,
  tags: ["orders"], server_urls: ["https://orders.example.test"], operation_count: 2,
  uncompressed_size: 80, content_hash: "fixture-hash", content_encoding: "gzip",
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
let requests: Request[];
const respond = vi.fn<(request: Request) => Response>();
const popup = vi.fn();

beforeEach(() => {
  requests = [];
  respond.mockReset();
  popup.mockClear();
  setApiErrorHandler(popup);
  setCsrfToken("fixture-csrf");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    return respond(request);
  }));
});
afterEach(() => {
  setApiErrorHandler(undefined);
  setCsrfToken(null);
  localStorage.clear();
  vi.unstubAllGlobals();
});

function listPage(items = [summary], total = items.length, offset = 0, next: number | null = null) {
  return { items, total, offset, next_offset: next, limit: 250 };
}

describe("API spec request contracts", () => {
  it("serializes filters, preserves zero offsets, and omits empty or undefined filters", async () => {
    respond.mockReturnValue(Response.json(listPage()));
    expect(await specs.list(scope, {
      offset: 0, limit: 25, proxy_id: "orders", title_contains: "order & stock",
      has_tag: "", spec_version: undefined, updated_since: "2026-09-01T00:00:00Z",
      sort_by: "updated_at", order: "desc",
    })).toEqual(listPage());
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/api/proxy/api-specs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      offset: "0", limit: "25", proxy_id: "orders", title_contains: "order & stock",
      updated_since: "2026-09-01T00:00:00Z", sort_by: "updated_at", order: "desc",
    });
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
  });

  it("accepts default filters and a truly empty inventory", async () => {
    respond.mockImplementation(() => Response.json(listPage([])));
    expect(await specs.list(scope)).toEqual(listPage([]));
    expect(new URL(requests[0].url).search).toBe("");
    expect(await specs.listAll(scope)).toEqual([]);
  });

  it("collects the items/next_offset envelope under the captured namespace", async () => {
    respond.mockImplementationOnce(() => {
      localStorage.setItem("ferrum:namespace", "tenant-b");
      return Response.json(listPage([summary], 2, 0, 1));
    }).mockImplementationOnce(() => Response.json(listPage([{ ...summary, id: "stock" }], 2, 1)));
    expect((await specs.listAll(scope)).map((item) => item.id)).toEqual(["orders-spec", "stock"]);
    expect(requests.map((request) => new URL(request.url).searchParams.get("offset"))).toEqual(["0", "1"]);
    expect(requests.every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
  });

  it.each([
    ["negative total", { total: -1 }, "inconsistent"],
    ["fractional total", { total: 1.5 }, "inconsistent"],
    ["wrong offset", { offset: 2 }, "inconsistent"],
    ["too many records", { total: 0 }, "more API specs"],
    ["missing cursor", { total: 2 }, "stopped advancing"],
    ["empty intermediate page", { total: 2, items: [], next_offset: 1 }, "stopped advancing"],
    ["repeated cursor", { total: 2, next_offset: 0 }, "non-advancing"],
    ["fractional cursor", { total: 2, next_offset: 0.5 }, "non-advancing"],
  ] as const)("rejects %s instead of silently truncating the inventory", async (_label, changes, message) => {
    respond.mockImplementation(() => Response.json({ ...listPage(), ...changes }));
    await expect(specs.listAll(scope)).rejects.toThrow(message);
    expect(requests).toHaveLength(1);
  });

  it("rejects a total that changes between pages", async () => {
    respond.mockImplementationOnce(() => Response.json(listPage([summary], 2, 0, 1)))
      .mockImplementationOnce(() => Response.json(listPage([summary], 3, 1, 2)));
    await expect(specs.listAll(scope)).rejects.toThrow("changed API spec pagination total");
    expect(requests).toHaveLength(2);
  });

  it("requests YAML document text without converting it to a JSON envelope", async () => {
    const document = "openapi: 3.1.0\ninfo:\n  title: Orders\n";
    respond.mockReturnValue(new Response(document, { headers: { "content-type": "application/yaml" } }));
    expect(await specs.getDocument(scope, "orders-spec")).toBe(document);
    expect(requests[0].headers.get("accept")).toBe("application/yaml");
    expect(new URL(requests[0].url).pathname).toBe("/api/proxy/api-specs/orders-spec");
  });

  it.each([
    ["create", "  {\"openapi\":\"3.1.0\"}", "POST", "application/json"],
    ["update", "openapi: 3.1.0\n", "PUT", "application/yaml"],
  ] as const)("sends raw %s material with its detected content type", async (action, document, method, contentType) => {
    const accepted: specs.ApiSpecCreateResponse = {
      id: "orders-spec", proxy_id: "orders", spec_version: "3.1.0", content_hash: "hash",
    };
    respond.mockReturnValue(Response.json(accepted));
    const result = action === "create"
      ? await specs.create(scope, document)
      : await specs.update(scope, "orders-spec", document);
    expect(result).toEqual(accepted);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe(method);
    expect(new URL(requests[0].url).pathname).toBe(
      `/api/proxy/api-specs${action === "update" ? "/orders-spec" : ""}`,
    );
    expect(requests[0].headers.get("content-type")).toBe(contentType);
    expect(requests[0].headers.get("X-CSRF-Token")).toBe("fixture-csrf");
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    expect(await requests[0].text()).toBe(document);
  });

  it("deletes only the named spec in the bound namespace", async () => {
    respond.mockReturnValue(new Response(null, { status: 204 }));
    await specs.remove(scope, "orders-spec");
    expect(requests[0].method).toBe("DELETE");
    expect(new URL(requests[0].url).pathname).toBe("/api/proxy/api-specs/orders-spec");
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
  });

  it.each([
    [{ error: "Spec parse failed", code: "invalid_yaml", details: "line 3: expected mapping" },
      "invalid_yaml: line 3: expected mapping"],
    [{ error: "Validation failed", failures: [{ resource_type: "proxy", id: "orders", errors: ["hosts required"] }] },
      "Validation failed\nproxy (orders): hosts required"],
  ])("retains actionable error data after ky consumes the failing response", async (body, detail) => {
    respond.mockReturnValue(Response.json(body, { status: 400 }));
    const error = await specs.create(scope, "invalid").catch((failure: unknown) => failure);
    expect(isHTTPError(error)).toBe(true);
    if (!isHTTPError(error)) throw new Error("Expected an HTTP error");
    expect(error.response.bodyUsed).toBe(true);
    expect(await getApiErrorDetail(error)).toBe(detail);
    expect(popup).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("reports an uncertain import once without replaying the write", async () => {
    respond.mockImplementation(() => Response.json({ error: "Unavailable" }, { status: 503 }));
    await expect(specs.create(scope, "openapi: 3.1.0")).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(requests).toHaveLength(1);
    expect(popup).not.toHaveBeenCalled();
  });
});
