import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proxy } from "./types";
import { listAll, mergeFormUpdatePayload, toUpdatePayload } from "./proxies";

function fullProxy(): Proxy {
  return {
    id: "proxy-1",
    namespace: "ferrum",
    name: "before",
    listen_path: "/before",
    hosts: ["api.example.com"],
    backend_scheme: "https",
    backend_host: "backend.example.com",
    backend_port: 443,
    backend_path: "/v1",
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 1_000,
    backend_read_timeout_ms: 2_000,
    backend_write_timeout_ms: 3_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [{ plugin_config_id: "group-1" }],
    frontend_tls: true,
    passthrough: false,
    stream_match: {
      arms: [{ source_namespace: "trusted", source_subnets: ["10.0.0.0/8"] }],
    },
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: ["https://console.example.com"],
    response_body_mode: "stream",
    pool_enable_http_keep_alive: null,
    pool_enable_http2: null,
    pool_http2_adaptive_window: null,
    pool_max_requests_per_connection: 900,
    api_spec_id: "spec-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
}

describe("proxy full-replacement builders", () => {
  it("strips only server-owned fields", () => {
    const payload = toUpdatePayload(fullProxy());
    expect(payload).not.toHaveProperty("created_at");
    expect(payload).not.toHaveProperty("updated_at");
    expect(payload).not.toHaveProperty("namespace");
    expect(payload).not.toHaveProperty("api_spec_id");
    expect(payload.stream_match).toEqual(fullProxy().stream_match);
  });

  it("preserves opaque routing and pool fields when editing a basic field", () => {
    const payload = mergeFormUpdatePayload(fullProxy(), {
      backend_host: "backend.example.com",
      backend_port: 443,
      name: "after",
      pool_max_requests_per_connection: 900,
    });

    expect(payload.name).toBe("after");
    expect(payload.stream_match).toEqual(fullProxy().stream_match);
    expect(payload.pool_max_requests_per_connection).toBe(900);
    expect(payload.plugins).toEqual([{ plugin_config_id: "group-1" }]);
    expect(payload.pool_enable_http_keep_alive).toBeNull();
    expect(payload.pool_enable_http2).toBeNull();
    expect(payload.pool_http2_adaptive_window).toBeNull();
  });

  it("distinguishes explicit false from inherited null", () => {
    const payload = mergeFormUpdatePayload(fullProxy(), {
      backend_host: "backend.example.com",
      backend_port: 443,
      pool_enable_http_keep_alive: false,
      pool_enable_http2: false,
      pool_http2_adaptive_window: false,
    });
    expect(payload.pool_enable_http_keep_alive).toBe(false);
    expect(payload.pool_enable_http2).toBe(false);
    expect(payload.pool_http2_adaptive_window).toBe(false);
  });

  it("uses explicit null/empty values to clear form-owned optionals", () => {
    const payload = mergeFormUpdatePayload(fullProxy(), {
      backend_host: "backend.example.com",
      backend_port: 443,
    });
    expect(payload.listen_path).toBeNull();
    expect(payload.backend_path).toBeNull();
    expect(payload.hosts).toEqual([]);
    expect(payload.allowed_ws_origins).toEqual([]);
  });
});

/* ================================================================== */
/*  listAll namespace binding                                          */
/* ================================================================== */

describe("listAll", () => {
  const captured: Array<{ offset: string | null; namespace: string | null }> = [];

  class BasedRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
        input = new URL(input, "http://localhost").toString();
      }
      super(input, init);
    }
  }

  beforeEach(() => {
    captured.length = 0;
    localStorage.setItem("ferrum:namespace", "tenant-a");
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        const namespace = request.headers.get("x-ferrum-namespace");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        captured.push({ offset: String(offset), namespace });
        // The tab (or another one) switches between the first and second
        // page; the shared preference now says tenant-b.
        localStorage.setItem("ferrum:namespace", "tenant-b");
        const rows = [
          { id: "a-1", namespace },
          { id: "a-2", namespace },
          { id: "a-3", namespace },
        ];
        return new Response(
          JSON.stringify({
            data: rows.slice(offset, offset + 2),
            pagination: { offset, limit: 250, total: rows.length },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("ferrum:namespace");
  });

  it("carries the starting namespace on every page", async () => {
    const rows = await listAll({ namespace: "tenant-a" });

    expect(captured).toEqual([
      { offset: "0", namespace: "tenant-a" },
      { offset: "2", namespace: "tenant-a" },
    ]);
    // A page fetched under the switched namespace would show up here as a
    // tenant-b record inside a collection cached as tenant-a.
    expect(rows.map((proxy) => proxy.namespace)).toEqual([
      "tenant-a",
      "tenant-a",
      "tenant-a",
    ]);
  });
});
