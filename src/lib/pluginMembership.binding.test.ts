import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, Proxy } from "@/api/types";
import { isStaleResourceError } from "@/api/conditionalWrite";
import { setApiErrorHandler } from "@/api/client";
import { pluginWriteGuard, toUpdatePayload } from "@/api/plugins";
import {
  bindPluginMembership,
  createPluginWithMembership,
  deletePluginWithMembership,
  PluginMembershipChangedError,
  updatePluginWithMembership,
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
    proxies.set("p3", { ...makeProxy("p3", "v1"), plugins: [] });
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
        if (request.method === "PUT" && path === "plugins/config/plugin-1") {
          return json({ ...plugin, ...((await request.clone().json()) as object) });
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

    await expect(
      updatePluginWithMembership(
        "plugin-1",
        toUpdatePayload(plugin),
        ["p3"],
        deps,
        null,
        ["p1", "p2"],
      ),
    ).rejects.toThrow("compensating rollback was attempted");

    // p3 was attached and p1 detached, p2 failed, so the rollback reattached
    // p1, kept the added p3 (detaching it could cascade, #618), and restored
    // the configuration; it then reports the plugin and its remaining references.
    expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      "GET plugins/config/plugin-1",
      "PUT plugins/config/plugin-1",
      "GET proxies/p3",
      "PUT proxies/p3",
      "GET proxies/p1",
      "PUT proxies/p1",
      "GET proxies/p2",
      "PUT proxies/p2",
      "GET proxies/p1",
      "GET plugins/config/plugin-1",
      "PUT proxies/p1",
      "GET plugins/config/plugin-1",
      "GET proxies",
      "PUT plugins/config/plugin-1",
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
  let untaggedPluginReads = false;
  let vanishBeforeDelete = false;
  /** Another operator attaches this proxy to plugin-1 when the next request of `method` arrives. */
  let attachOn: { method: string; proxy: string } | null = null;
  /** The `expected_proxy_ids` each plugin `PUT`/`DELETE` carried. */
  const expectedSent: (string | null)[] = [];

  function attachPlugin1(proxyPath: string): void {
    const entry = store.get(proxyPath)!;
    const proxy = entry.value as Proxy;
    entry.revision += 1;
    entry.value = {
      ...proxy,
      plugins: [...proxy.plugins, { plugin_config_id: "plugin-1" }],
      updated_at: `attached-${entry.revision}`,
    };
  }

  /**
   * Edge's association precondition (forge-ops #569), as the mock admin
   * gateway enforces it: a proxy referencing the configuration outside
   * `expected_proxy_ids` (a proxy-scoped write's own target aside) is a `412`.
   */
  function associationRefusal(path: string, expected: string, kept?: string): boolean {
    const id = path.replace("plugins/config/", "");
    const allowed = new Set(expected === "" ? [] : expected.split(","));
    return [...store.entries()].some(([key, entry]) => {
      if (!key.startsWith("proxies/")) return false;
      const proxy = entry.value as Proxy;
      return proxy.id !== kept && !allowed.has(proxy.id) &&
        proxy.plugins.some((a) => a.plugin_config_id === id);
    });
  }

  const tag = (path: string) => `"${path}@${store.get(path)!.revision}"`;

  /**
   * Edge 0.9.x (ferrum-edge#4611): a proxy-scoped plugin write attaches the
   * association to its proxy, a re-home or a move to global detaches it, in
   * the same transaction — and every proxy it changes gets a new revision and
   * `updated_at`. Group membership is left to proxy writes.
   */
  function reconcileProxyScope(config: PluginConfig): void {
    if (config.scope === "proxy_group") return;
    for (const [key, entry] of store) {
      if (!key.startsWith("proxies/")) continue;
      const proxy = entry.value as Proxy;
      const has = proxy.plugins.some((a) => a.plugin_config_id === config.id);
      const should = config.scope === "proxy" && config.proxy_id === proxy.id;
      if (has === should) continue;
      const plugins = proxy.plugins.filter((a) => a.plugin_config_id !== config.id);
      if (should) plugins.push({ plugin_config_id: config.id });
      entry.revision += 1;
      entry.value = { ...proxy, plugins, updated_at: `touched-${entry.revision}` };
    }
  }

  beforeEach(() => {
    store.clear();
    wire.length = 0;
    interleaveOnPut = null;
    untaggedPluginReads = false;
    vanishBeforeDelete = false;
    attachOn = null;
    expectedSent.length = 0;
    store.set("plugins/config/plugin-1", { value: plugin, revision: 0 });
    store.set("proxies/p1", { value: makeProxy("p1", "v1"), revision: 0 });
    store.set("proxies/p2", { value: makeProxy("p2", "v1"), revision: 0 });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        const url = new URL(input.url);
        const path = url.pathname.replace("/api/proxy/", "");
        const ifMatch = input.headers.get("if-match");
        wire.push(`${input.method} ${path}${ifMatch ? ` if-match ${ifMatch}` : ""}`);
        if (attachOn && attachOn.method === input.method) {
          attachPlugin1(`proxies/${attachOn.proxy}`);
          attachOn = null;
        }
        const pluginWrite = path.startsWith("plugins/config/") &&
          (input.method === "PUT" || input.method === "DELETE");
        const expected = pluginWrite ? url.searchParams.get("expected_proxy_ids") : null;
        if (pluginWrite) expectedSent.push(expected);

        if (input.method === "GET" && path === "proxies") {
          const data = [...store.entries()]
            .filter(([key]) => key.startsWith("proxies/"))
            .map(([, entry]) => entry.value);
          return json({ data, pagination: { offset: 0, limit: 250, total: data.length } });
        }
        if (input.method === "POST" && path === "plugins/config") {
          const body = (await input.clone().json()) as PluginConfig;
          const created = { ...body, created_at: "c1", updated_at: "c1" };
          store.set(`plugins/config/${created.id}`, { value: created, revision: 0 });
          reconcileProxyScope(created);
          return json(created, 201);
        }
        // Another operator deletes it between the plan's read and its DELETE.
        if (vanishBeforeDelete && input.method === "DELETE") {
          vanishBeforeDelete = false;
          store.delete(path);
        }
        const entry = store.get(path);
        if (!entry) return json({ error: "Not Found" }, 404);
        if (input.method === "GET") {
          // Edge's cached fallback answers without a tag.
          const untagged = untaggedPluginReads && path.startsWith("plugins/");
          return new Response(JSON.stringify(entry.value), {
            headers: {
              "content-type": "application/json",
              ...(!untagged && { etag: tag(path) }),
            },
          });
        }
        // Another administrator edits this proxy after the plan's preflight
        // read, without moving `updated_at` — the change the plan's own
        // `updated_at` comparison cannot see.
        if (interleaveOnPut === path) {
          interleaveOnPut = null;
          entry.value = path.startsWith("plugins/")
            ? { ...entry.value, config: { requests: 99 } } as PluginConfig
            : { ...entry.value, backend_host: "moved.internal" } as Proxy;
          entry.revision += 1;
        }
        if (ifMatch !== null && ifMatch !== tag(path)) {
          return json({ error: "Precondition Failed" }, 412);
        }
        if (pluginWrite) {
          if (expected === null) return json({ error: "expected_proxy_ids is required" }, 400);
          const body = input.method === "PUT"
            ? (await input.clone().json()) as PluginConfig
            : undefined;
          const kept = body?.scope === "proxy" ? body.proxy_id : undefined;
          if (associationRefusal(path, expected, kept)) {
            return json({ error: "referenced by proxies outside expected_proxy_ids" }, 412);
          }
        }
        if (input.method === "DELETE") {
          store.delete(path);
          // Edge removes a deleted configuration from every proxy that lists
          // it, in the same transaction.
          for (const [key, other] of store) {
            if (!key.startsWith("proxies/")) continue;
            const proxy = other.value as Proxy;
            const id = path.replace("plugins/config/", "");
            if (!proxy.plugins.some((a) => a.plugin_config_id === id)) continue;
            other.revision += 1;
            other.value = {
              ...proxy,
              plugins: proxy.plugins.filter((a) => a.plugin_config_id !== id),
              updated_at: `touched-${other.revision}`,
            };
          }
          return new Response(null, { status: 204 });
        }
        const body = (await input.clone().json()) as object;
        entry.value = { ...entry.value, ...body } as Proxy | PluginConfig;
        entry.revision += 1;
        const written = entry.value;
        if (path.startsWith("plugins/")) reconcileProxyScope(written as PluginConfig);
        return json(written);
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
      ["p1", "p2"],
    );

    // One conditional DELETE; Edge detaches the members in the same
    // transaction, so no proxy is written first.
    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      'DELETE plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
    ]);
    expect(store.has("plugins/config/plugin-1")).toBe(false);
    expect((store.get("proxies/p1")!.value as Proxy).plugins).toEqual([]);
    expect((store.get("proxies/p2")!.value as Proxy).plugins).toEqual([]);
    // The precondition names the members the page showed.
    expect(expectedSent).toEqual(["p1,p2"]);
  });

  it("sends the membership the page showed, so Edge refuses a delete after a concurrent attach (#630)", async () => {
    store.set("proxies/p3", { value: { ...makeProxy("p3", "v1"), plugins: [] }, revision: 0 });
    // Another operator attaches p3 after the plan's listing, just before the DELETE.
    attachOn = { method: "DELETE", proxy: "p3" };

    const refused = await deletePluginWithMembership(
      "plugin-1",
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(plugin),
      ["p1", "p2"],
    ).then(() => null, (error: unknown) => error);

    expect(refused).toBeInstanceOf(PluginMembershipChangedError);
    expect((refused as PluginMembershipChangedError).unexpectedProxyIds).toEqual(["p3"]);
    expect((refused as Error).message).toContain("Nothing was deleted");
    expect((refused as Error).message).toContain("Reload");
    // Not a fresh listing's {p1, p2, p3}: the set the page rendered.
    expect(expectedSent).toEqual(["p1,p2"]);
    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      'DELETE plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
      "GET plugins/config/plugin-1",
      "GET proxies",
    ]);
    expect(store.has("plugins/config/plugin-1")).toBe(true);
    expect((store.get("proxies/p3")!.value as Proxy).plugins).toEqual([
      { plugin_config_id: "plugin-1" },
    ]);
  });

  it("sends no DELETE when its own listing shows a proxy attached since the page loaded (#630)", async () => {
    store.set("proxies/p3", { value: { ...makeProxy("p3", "v1"), plugins: [] }, revision: 0 });
    // Attached between the page's render and the delete: a fresh listing
    // would now name p3 and Edge would accept a DELETE that detaches it.
    attachOn = { method: "GET", proxy: "p3" };

    const refused = await deletePluginWithMembership(
      "plugin-1",
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(plugin),
      ["p1", "p2"],
    ).then(() => null, (error: unknown) => error);

    expect(refused).toBeInstanceOf(PluginMembershipChangedError);
    expect((refused as PluginMembershipChangedError).unexpectedProxyIds).toEqual(["p3"]);
    expect(wire).toEqual(["GET plugins/config/plugin-1", "GET proxies"]);
    expect(expectedSent).toEqual([]);
    expect(store.has("plugins/config/plugin-1")).toBe(true);
  });

  it("sends the membership the editor showed on a scope change, so Edge refuses it after a concurrent attach (#630)", async () => {
    store.set("proxies/p3", { value: { ...makeProxy("p3", "v1"), plugins: [] }, revision: 0 });
    attachOn = { method: "PUT", proxy: "p3" };

    const refused = await updatePluginWithMembership(
      "plugin-1",
      { ...toUpdatePayload(plugin), scope: "global" },
      [],
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(plugin),
      ["p1", "p2"],
    ).then(() => null, (error: unknown) => error);

    expect(refused).toBeInstanceOf(PluginMembershipChangedError);
    expect((refused as Error).message).toContain("Nothing was saved");
    expect(expectedSent).toEqual(["p1,p2"]);
    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      "GET plugins/config/plugin-1",
      'PUT plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
      "GET plugins/config/plugin-1",
      "GET proxies",
    ]);
    // Nothing was rolled back, because nothing was written.
    expect((store.get("plugins/config/plugin-1")!.value as PluginConfig).scope).toBe("proxy_group");
    for (const id of ["p1", "p2", "p3"]) {
      expect((store.get(`proxies/${id}`)!.value as Proxy).plugins).toEqual([
        { plugin_config_id: "plugin-1" },
      ]);
    }
  });

  it("resolves a DELETE that finds the plugin already gone, without an error popup", async () => {
    vanishBeforeDelete = true;
    const popups = vi.fn();
    setApiErrorHandler(popups);
    try {
      await deletePluginWithMembership(
        "plugin-1",
        bindPluginMembership({ namespace: "tenant-a" }),
        pluginWriteGuard(plugin),
        ["p1", "p2"],
      );
    } finally {
      setApiErrorHandler(undefined);
    }
    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      'DELETE plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
    ]);
    expect(popups).not.toHaveBeenCalled();
  });

  it("sends no DELETE when the plugin read is untagged", async () => {
    untaggedPluginReads = true;

    await expect(
      deletePluginWithMembership(
        "plugin-1",
        bindPluginMembership({ namespace: "tenant-a" }),
        null,
        ["p1", "p2"],
      ),
    ).rejects.toThrow("did not provide a usable strong ETag");

    expect(wire).toEqual(["GET plugins/config/plugin-1"]);
    expect(store.has("plugins/config/plugin-1")).toBe(true);
  });

  it("keeps a group whose configuration changed after the editor's check (#609)", async () => {
    interleaveOnPut = "plugins/config/plugin-1";

    const refused = await deletePluginWithMembership(
      "plugin-1",
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(plugin),
      ["p1", "p2"],
    ).then(() => null, (error: unknown) => error);

    if (!isStaleResourceError(refused)) throw new Error("expected a stale delete");
    expect(refused.detail.current.config).toEqual({ requests: 99 });
    expect(wire).toEqual([
      "GET plugins/config/plugin-1",
      "GET proxies",
      'DELETE plugins/config/plugin-1 if-match "plugins/config/plugin-1@0"',
      "GET plugins/config/plugin-1",
    ]);
    expect((store.get("plugins/config/plugin-1")!.value as PluginConfig).config).toEqual({
      requests: 99,
    });
    expect((store.get("proxies/p1")!.value as Proxy).plugins).toEqual([
      { plugin_config_id: "plugin-1" },
    ]);
  });

  it("aborts on a change its updated_at comparison cannot see, instead of overwriting it", async () => {
    interleaveOnPut = "proxies/p2";

    await expect(
      updatePluginWithMembership(
        "plugin-1",
        toUpdatePayload(plugin),
        ["p1"],
        bindPluginMembership({ namespace: "tenant-a" }),
        null,
        ["p1", "p2"],
      ),
    ).rejects.toThrow("Proxy p2 changed during membership preflight");

    const p2 = store.get("proxies/p2")!.value as Proxy;
    expect(p2.backend_host).toBe("moved.internal");
    expect(p2.plugins).toEqual([{ plugin_config_id: "plugin-1" }]);
    expect(store.has("plugins/config/plugin-1")).toBe(true);
  });

  it("shows the editor the comparison when its plugin changes between the plan's read and its PUT", async () => {
    interleaveOnPut = "plugins/config/plugin-1";

    const refused = await updatePluginWithMembership(
      "plugin-1",
      { plugin_name: "rate_limiting", config: { requests: 20 }, scope: "proxy_group", enabled: true },
      ["p1", "p2"],
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(plugin),
      ["p1", "p2"],
    ).then(() => null, (error: unknown) => error);

    if (!isStaleResourceError(refused)) throw new Error("expected a stale write");
    expect(refused.detail.current.config).toEqual({ requests: 99 });
    expect(refused.detail.proposed.config).toEqual({ requests: 20 });
    expect((store.get("plugins/config/plugin-1")!.value as PluginConfig).config).toEqual({ requests: 99 });
    expect(wire.filter((call) => call.startsWith("PUT proxies"))).toEqual([]);
  });

  it("does not mistake Edge's attach-on-create proxy bump for a concurrent change", async () => {
    // The plan lists the proxies before the create; the create then moves p1's
    // revision and `updated_at`. Nothing the plan compares or conditions a
    // write on may come from before that create.
    const created = await createPluginWithMembership(
      {
        id: "keyauth-1",
        plugin_name: "key_auth",
        config: {},
        scope: "proxy",
        proxy_id: "p1",
        enabled: true,
      },
      [],
      bindPluginMembership({ namespace: "tenant-a" }),
    );

    expect(created.id).toBe("keyauth-1");
    expect(wire).toEqual(["GET proxies", "POST plugins/config", "GET proxies/p1"]);
    const p1 = store.get("proxies/p1")!;
    expect(p1.revision, "only the gateway's own attach moved the proxy").toBe(1);
    expect((p1.value as Proxy).plugins).toEqual([
      { plugin_config_id: "plugin-1" },
      { plugin_config_id: "keyauth-1" },
    ]);
  });

  it("does not mistake Edge's re-home of a proxy-scoped plugin for a concurrent change", async () => {
    const keyauth: PluginConfig = {
      id: "keyauth-1",
      plugin_name: "key_auth",
      config: {},
      scope: "proxy",
      proxy_id: "p1",
      enabled: true,
      created_at: "v0",
      updated_at: "v0",
    };
    store.set("plugins/config/keyauth-1", { value: keyauth, revision: 0 });
    store.set("proxies/p1", {
      value: { ...makeProxy("p1", "v1"), plugins: [{ plugin_config_id: "keyauth-1" }] },
      revision: 0,
    });
    store.set("proxies/p2", { value: { ...makeProxy("p2", "v1"), plugins: [] }, revision: 0 });

    await updatePluginWithMembership(
      "keyauth-1",
      { ...toUpdatePayload(keyauth), proxy_id: "p2" },
      [],
      bindPluginMembership({ namespace: "tenant-a" }),
      pluginWriteGuard(keyauth),
      ["p1"],
    );

    // The plugin PUT re-homes the association and bumps both proxies; the plan
    // then only reads them back.
    expect(wire).toEqual([
      "GET plugins/config/keyauth-1",
      "GET proxies",
      "GET plugins/config/keyauth-1",
      'PUT plugins/config/keyauth-1 if-match "plugins/config/keyauth-1@0"',
      "GET proxies/p2",
      "GET proxies/p1",
    ]);
    expect((store.get("proxies/p1")!.value as Proxy).plugins).toEqual([]);
    expect((store.get("proxies/p2")!.value as Proxy).plugins).toEqual([
      { plugin_config_id: "keyauth-1" },
    ]);
  });
});
