import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, Proxy } from "@/api/types";
import {
  bindPluginMembership,
  deletePluginWithMembership,
} from "./pluginMembership";

/**
 * Wire-level check that a membership plan — listing, preflight reads, the
 * association writes, and the compensating rollback after a failure — stays
 * in the namespace the plan was bound to, whatever storage says by then.
 */

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = new URL(input, "http://localhost").toString();
    }
    super(input, init);
  }
}

interface CapturedRequest {
  method: string;
  path: string;
  namespace: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeProxy(id: string, updatedAt: string): Proxy {
  return {
    id,
    backend_host: `${id}.internal`,
    backend_port: 443,
    hosts: [],
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 1_000,
    backend_read_timeout_ms: 1_000,
    backend_write_timeout_ms: 1_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [{ plugin_config_id: "plugin-1" }],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "v0",
    updated_at: updatedAt,
  };
}

const plugin: PluginConfig = {
  id: "plugin-1",
  plugin_name: "rate_limiting",
  config: { requests: 10 },
  scope: "proxy_group",
  enabled: true,
  created_at: "v0",
  updated_at: "v0",
};

describe("plugin membership plans bind every request to the starting namespace", () => {
  const captured: CapturedRequest[] = [];
  const proxies = new Map<string, Proxy>();

  beforeEach(() => {
    captured.length = 0;
    proxies.clear();
    proxies.set("p1", makeProxy("p1", "v1"));
    proxies.set("p2", makeProxy("p2", "v1"));
    localStorage.setItem("ferrum:namespace", "tenant-a");
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        const path = url.pathname.replace("/api/proxy/", "");
        captured.push({
          method: request.method,
          path,
          namespace: request.headers.get("x-ferrum-namespace"),
        });
        // Another tab moves the shared preference as soon as the plan has
        // started; nothing below may follow it.
        localStorage.setItem("ferrum:namespace", "tenant-b");

        if (request.method === "GET" && path === "plugins/config/plugin-1") {
          return json(plugin);
        }
        if (request.method === "GET" && path === "proxies") {
          return json({
            data: [...proxies.values()],
            pagination: { offset: 0, limit: 250, total: proxies.size },
          });
        }
        const proxyMatch = /^proxies\/(p\d)$/.exec(path);
        if (proxyMatch && request.method === "GET") {
          return json(proxies.get(proxyMatch[1]));
        }
        if (proxyMatch && request.method === "PUT") {
          if (proxyMatch[1] === "p2") {
            return json({ error: "injected failure" }, 422);
          }
          const body = (await request.clone().json()) as Partial<Proxy>;
          const current = proxies.get(proxyMatch[1])!;
          const next = { ...current, ...body, id: current.id, updated_at: "v2" } as Proxy;
          proxies.set(current.id, next);
          return json(next);
        }
        return json({ error: `unexpected ${request.method} ${path}` }, 500);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("ferrum:namespace");
  });

  it("keeps listing, preflight, apply, and rollback in the bound namespace", async () => {
    const deps = bindPluginMembership({ namespace: "tenant-a" });

    await expect(deletePluginWithMembership("plugin-1", deps)).rejects.toThrow(
      "membership rollback was attempted",
    );

    // p1 was detached, p2 failed, so p1 was restored by the rollback.
    expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      "GET proxies/p1",
      "PUT proxies/p1",
      "GET proxies/p2",
      "PUT proxies/p2",
      "GET proxies/p1",
      "PUT proxies/p1",
    ]);
    expect(captured.every((r) => r.namespace === "tenant-a")).toBe(true);
    expect(localStorage.getItem("ferrum:namespace")).toBe("tenant-b");
  });
});
