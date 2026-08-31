import { describe, expect, it } from "vitest";
import type {
  PluginConfig,
  PluginConfigCreate,
  Proxy,
  ProxyCreate,
} from "@/api/types";
import {
  createPluginWithMembership,
  deletePluginWithMembership,
  type PluginMembershipDependencies,
  updatePluginWithMembership,
} from "./pluginMembership";

function makeProxy(id: string, pluginIds: string[] = []): Proxy {
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
    plugins: pluginIds.map((plugin_config_id) => ({ plugin_config_id })),
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "v0",
    updated_at: "v0",
  };
}

function makePlugin(
  id: string,
  scope: PluginConfig["scope"] = "proxy_group",
): PluginConfig {
  return {
    id,
    plugin_name: "rate_limiting",
    config: { requests: 10 },
    scope,
    enabled: true,
    created_at: "v0",
    updated_at: "v0",
  };
}

interface HarnessOptions {
  failProxyOnce?: string;
  failPluginUpdate?: boolean;
  failPluginDelete?: boolean;
  mutateAfterList?: string;
}

function harness(
  initialProxies: Proxy[],
  initialPlugins: PluginConfig[] = [],
  options: HarnessOptions = {},
) {
  const proxies = new Map(initialProxies.map((proxy) => [proxy.id, structuredClone(proxy)]));
  const plugins = new Map(initialPlugins.map((plugin) => [plugin.id, structuredClone(plugin)]));
  let version = 0;
  let failedProxy = false;
  let listCalled = false;
  let createCalls = 0;
  let updatePluginCalls = 0;
  let updateProxyCalls = 0;
  let deleteCalls = 0;

  const stamp = () => `v${++version}`;
  const deps: PluginMembershipDependencies = {
    listProxies: async () => {
      const snapshots = [...proxies.values()].map((proxy) => structuredClone(proxy));
      if (!listCalled && options.mutateAfterList) {
        listCalled = true;
        const current = proxies.get(options.mutateAfterList);
        if (current) current.updated_at = stamp();
      }
      return snapshots;
    },
    getProxy: async (id) => {
      const proxy = proxies.get(id);
      if (!proxy) throw new Error(`missing proxy ${id}`);
      return structuredClone(proxy);
    },
    updateProxy: async (id: string, data: ProxyCreate) => {
      updateProxyCalls += 1;
      if (options.failProxyOnce === id && !failedProxy) {
        failedProxy = true;
        throw new Error(`injected proxy failure ${id}`);
      }
      const current = proxies.get(id);
      if (!current) throw new Error(`missing proxy ${id}`);
      const next = { ...current, ...structuredClone(data), id, updated_at: stamp() } as Proxy;
      proxies.set(id, next);
      return structuredClone(next);
    },
    getPlugin: async (id) => {
      const plugin = plugins.get(id);
      if (!plugin) throw new Error(`missing plugin ${id}`);
      return structuredClone(plugin);
    },
    createPlugin: async (data) => {
      createCalls += 1;
      const plugin = {
        ...structuredClone(data),
        id: data.id ?? "created-plugin",
        config: data.config ?? {},
        enabled: data.enabled ?? true,
        created_at: stamp(),
        updated_at: stamp(),
      } as PluginConfig;
      plugins.set(plugin.id, plugin);
      return structuredClone(plugin);
    },
    updatePlugin: async (id: string, data: PluginConfigCreate) => {
      updatePluginCalls += 1;
      if (options.failPluginUpdate && updatePluginCalls === 1) {
        throw new Error("injected plugin update failure");
      }
      const current = plugins.get(id);
      if (!current) throw new Error(`missing plugin ${id}`);
      const next = { ...current, ...structuredClone(data), id, updated_at: stamp() };
      plugins.set(id, next);
      return structuredClone(next);
    },
    deletePlugin: async (id) => {
      deleteCalls += 1;
      if (options.failPluginDelete) throw new Error("injected plugin delete failure");
      plugins.delete(id);
    },
  };

  return {
    deps,
    proxies,
    plugins,
    counts: () => ({ createCalls, updatePluginCalls, updateProxyCalls, deleteCalls }),
  };
}

function groupInput(scope: PluginConfig["scope"] = "proxy_group"): PluginConfigCreate {
  return {
    plugin_name: "rate_limiting",
    config: { requests: 20 },
    scope,
    enabled: true,
  };
}

function memberships(proxies: Map<string, Proxy>, pluginId: string): string[] {
  return [...proxies.values()]
    .filter((proxy) => proxy.plugins.some((entry) => entry.plugin_config_id === pluginId))
    .map((proxy) => proxy.id)
    .sort();
}

describe("proxy-group membership reconciliation", () => {
  it("preflights every desired proxy before creating the plugin", async () => {
    const state = harness([makeProxy("p1")]);
    await expect(createPluginWithMembership(
      groupInput(),
      ["p1", "missing"],
      state.deps,
    )).rejects.toThrow("Unknown proxy IDs");
    expect(state.counts().createCalls).toBe(0);
  });

  it("creates and associates a complete desired membership serially", async () => {
    const state = harness([makeProxy("p1"), makeProxy("p2"), makeProxy("p3")]);
    const created = await createPluginWithMembership(
      groupInput(),
      ["p1", "p3"],
      state.deps,
    );
    expect(memberships(state.proxies, created.id)).toEqual(["p1", "p3"]);
  });

  it.each(["p1", "p2", "p3"])(
    "rolls back associations and deletes an orphan when %s fails",
    async (failureId) => {
    const state = harness(
      [makeProxy("p1"), makeProxy("p2"), makeProxy("p3")],
      [],
      { failProxyOnce: failureId },
    );
    await expect(createPluginWithMembership(
      groupInput(),
      ["p1", "p2", "p3"],
      state.deps,
    )).rejects.toThrow("rollback was attempted");
    expect(memberships(state.proxies, "created-plugin")).toEqual([]);
    expect(state.plugins.has("created-plugin")).toBe(false);
    },
  );

  it("updates an existing group to the exact requested membership", async () => {
    const state = harness(
      [
        makeProxy("p1", ["plugin-1"]),
        makeProxy("p2", ["plugin-1"]),
        makeProxy("p3"),
      ],
      [makePlugin("plugin-1")],
    );
    await updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["p2", "p3"],
      state.deps,
    );
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p2", "p3"]);
  });

  it("does not rewrite an unchanged membership just because association order differs", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1", "unrelated-plugin"])],
      [makePlugin("plugin-1")],
    );

    await updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["p1"],
      state.deps,
    );

    expect(state.counts().updateProxyCalls).toBe(0);
    expect(state.proxies.get("p1")?.plugins).toEqual([
      { plugin_config_id: "plugin-1" },
      { plugin_config_id: "unrelated-plugin" },
    ]);
  });

  it("supports a global-to-group transition", async () => {
    const state = harness(
      [makeProxy("p1"), makeProxy("p2")],
      [makePlugin("plugin-1", "global")],
    );
    await updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["p2"],
      state.deps,
    );
    expect(state.plugins.get("plugin-1")?.scope).toBe("proxy_group");
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p2"]);
  });

  it("rolls back config and membership when entering group scope fails", async () => {
    const state = harness(
      [makeProxy("p1"), makeProxy("p2")],
      [makePlugin("plugin-1", "global")],
      { failProxyOnce: "p2" },
    );
    await expect(updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["p1", "p2"],
      state.deps,
    )).rejects.toThrow("rollback was attempted");
    expect(state.plugins.get("plugin-1")?.scope).toBe("global");
    expect(memberships(state.proxies, "plugin-1")).toEqual([]);
  });

  it("removes associations before a group-to-global transition", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2", ["plugin-1"])],
      [makePlugin("plugin-1")],
    );
    await updatePluginWithMembership("plugin-1", groupInput("global"), [], state.deps);
    expect(memberships(state.proxies, "plugin-1")).toEqual([]);
    expect(state.plugins.get("plugin-1")?.scope).toBe("global");
  });

  it("restores associations when a scope transition config update fails", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2", ["plugin-1"])],
      [makePlugin("plugin-1")],
      { failPluginUpdate: true },
    );
    await expect(updatePluginWithMembership(
      "plugin-1",
      groupInput("global"),
      [],
      state.deps,
    )).rejects.toThrow("rollback was attempted");
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p1", "p2"]);
    expect(state.plugins.get("plugin-1")?.scope).toBe("proxy_group");
  });

  it("refuses to overwrite a proxy changed after preflight", async () => {
    const state = harness(
      [makeProxy("p1")],
      [],
      { mutateAfterList: "p1" },
    );
    await expect(createPluginWithMembership(
      groupInput(),
      ["p1"],
      state.deps,
    )).rejects.toThrow("did not converge");
    expect(state.plugins.has("created-plugin")).toBe(false);
  });

  it("restores membership when plugin deletion fails", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2", ["plugin-1"])],
      [makePlugin("plugin-1")],
      { failPluginDelete: true },
    );
    await expect(deletePluginWithMembership("plugin-1", state.deps)).rejects.toThrow(
      "rollback was attempted",
    );
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p1", "p2"]);
    expect(state.plugins.has("plugin-1")).toBe(true);
  });
});
