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

    await expect(deletePluginWithMembership("plugin-1", deps, null)).rejects.toThrow(
      "membership rollback was attempted",
    );

    // p1 was detached, p2 failed, so p1 was restored by the rollback; the
    // cascade-aware rollback re-checks the plugin and the remaining references.
    expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      "GET proxies/p1",
      "PUT proxies/p1",
      "GET proxies/p2",
      "PUT proxies/p2",
      "GET proxies/p1",
      "GET plugins/config/plugin-1",
      "PUT proxies/p1",
      "GET plugins/config/plugin-1",
      "GET proxies",
    ]);
    expect(captured.every((r) => r.namespace === "tenant-a")).toBe(true);
    expect(localStorage.getItem("ferrum:namespace")).toBe("tenant-b");
  });
});

describe("plugin membership plans on a gateway that honours If-Match", () => {
  interface Stored {
    value: Proxy | PluginConfig;
    revision: number;
  }
  const store = new Map<string, Stored>();
  const wire: string[] = [];
  let interleaveOnPut: string | null = null;

  const tag = (path: string) => `"${path}@${store.get(path)!.revision}"`;

  beforeEach(() => {
    store.clear();
    wire.length = 0;
    interleaveOnPut = null;
    store.set("plugins/config/plugin-1", { value: plugin, revision: 0 });
    store.set("proxies/p1", { value: makeProxy("p1", "v1"), revision: 0 });
    store.set("proxies/p2", { value: makeProxy("p2", "v1"), revision: 0 });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        const path = new URL(input.url).pathname.replace("/api/proxy/", "");
        const ifMatch = input.headers.get("if-match");
        wire.push(`${input.method} ${path}${ifMatch ? ` if-match ${ifMatch}` : ""}`);

        if (input.method === "GET" && path === "proxies") {
          const data = [...store.entries()]
            .filter(([key]) => key.startsWith("proxies/"))
            .map(([, entry]) => entry.value);
          return json({ data, pagination: { offset: 0, limit: 250, total: data.length } });
        }
        const entry = store.get(path);
        if (!entry) return json({ error: "Not Found" }, 404);
        if (input.method === "GET") {
          return new Response(JSON.stringify(entry.value), {
            headers: { "content-type": "application/json", etag: tag(path) },
          });
        }
        // Another administrator edits this proxy after the plan's preflight
        // read, without moving `updated_at` — the change the plan's own
        // `updated_at` comparison cannot see.
        if (interleaveOnPut === path) {
          interleaveOnPut = null;
          entry.value = { ...entry.value, backend_host: "moved.internal" } as Proxy;
          entry.revision += 1;
        }
        if (ifMatch !== null && ifMatch !== tag(path)) {
          return json({ error: "Precondition Failed" }, 412);
        }
        if (input.method === "DELETE") {
          store.delete(path);
          return new Response(null, { status: 204 });
        }
        const body = (await input.clone().json()) as object;
        entry.value = { ...entry.value, ...body } as Proxy | PluginConfig;
        entry.revision += 1;
        return json(entry.value);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes every write conditional on the read the plan just compared", async () => {
    await deletePluginWithMembership(
      "plugin-1",
      bindPluginMembership({ namespace: "tenant-a" }),
      null,
    );

    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      "GET proxies/p1",
      'PUT proxies/p1 if-match "proxies/p1@0"',
      "GET proxies/p2",
      'PUT proxies/p2 if-match "proxies/p2@0"',
      "GET plugins/config/plugin-1",
      'DELETE plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
    ]);
    expect(store.has("plugins/config/plugin-1")).toBe(false);
  });

  it("aborts on a change its updated_at comparison cannot see, instead of overwriting it", async () => {
    interleaveOnPut = "proxies/p1";

    await expect(
      deletePluginWithMembership("plugin-1", bindPluginMembership({ namespace: "tenant-a" }), null),
    ).rejects.toThrow("Proxy p1 changed during membership preflight");

    const p1 = store.get("proxies/p1")!.value as Proxy;
    expect(p1.backend_host).toBe("moved.internal");
    expect(p1.plugins).toEqual([{ plugin_config_id: "plugin-1" }]);
    expect(store.has("plugins/config/plugin-1")).toBe(true);
  });
});
