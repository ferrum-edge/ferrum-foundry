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
  PluginMembershipError,
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
  failProxyCalls?: number[];
  losePluginOnFailure?: string;
  failPluginGetCall?: number;
}

function notFound(id: string): Error {
  return Object.assign(new Error(`missing plugin ${id}`), {
    response: { status: 404 },
  });
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
  let getPluginCalls = 0;
  const operations: string[] = [];

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
      operations.push(`proxy:${id}`);
      if (
        (options.failProxyOnce === id && !failedProxy) ||
        options.failProxyCalls?.includes(updateProxyCalls)
      ) {
        failedProxy = true;
        if (options.losePluginOnFailure) {
          const pluginId = options.losePluginOnFailure;
          plugins.delete(pluginId);
          for (const proxy of proxies.values()) {
            if (proxy.plugins.some((entry) => entry.plugin_config_id === pluginId)) {
              proxy.plugins = proxy.plugins.filter(
                (entry) => entry.plugin_config_id !== pluginId,
              );
              proxy.updated_at = stamp();
            }
          }
        }
        throw new Error(`injected proxy failure ${id}`);
      }
      const current = proxies.get(id);
      if (!current) throw new Error(`missing proxy ${id}`);
      for (const association of data.plugins ?? []) {
        const plugin = plugins.get(association.plugin_config_id);
        if (!plugin) throw notFound(association.plugin_config_id);
        if (
          plugin.scope === "global" ||
          (plugin.scope === "proxy" && plugin.proxy_id !== id)
        ) {
          throw new Error(`incompatible plugin scope on ${id}`);
        }
      }
      const next = { ...current, ...structuredClone(data), id, updated_at: stamp() } as Proxy;
      proxies.set(id, next);
      for (const association of current.plugins) {
        const pluginId = association.plugin_config_id;
        if (
          plugins.get(pluginId)?.scope === "proxy_group" &&
          memberships(proxies, pluginId).length === 0
        ) {
          plugins.delete(pluginId);
          operations.push(`cascade:${pluginId}`);
        }
      }
      return structuredClone(next);
    },
    getPlugin: async (id) => {
      getPluginCalls += 1;
      operations.push(`get:${id}`);
      if (options.failPluginGetCall === getPluginCalls) {
        throw Object.assign(new Error("injected plugin read failure"), {
          response: { status: 503 },
        });
      }
      const plugin = plugins.get(id);
      if (!plugin) throw notFound(id);
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
      operations.push(`plugin:${data.scope}`);
      if (options.failPluginUpdate && updatePluginCalls === 1) {
        throw new Error("injected plugin update failure");
      }
      const current = plugins.get(id);
      if (!current) throw notFound(id);
      const next = {
        ...current,
        proxy_id: undefined,
        ...structuredClone(data),
        id,
        updated_at: stamp(),
      };
      plugins.set(id, next);
      // Plugin PUT reconciles global/proxy associations atomically on Edge.
      if (next.scope !== "proxy_group") {
        for (const proxy of proxies.values()) {
          const wasAttached = proxy.plugins.some(
            (entry) => entry.plugin_config_id === id,
          );
          const shouldAttach = next.scope === "proxy" && next.proxy_id === proxy.id;
          if (wasAttached === shouldAttach) continue;
          proxy.plugins = proxy.plugins.filter(
            (entry) => entry.plugin_config_id !== id,
          );
          if (shouldAttach) proxy.plugins.push({ plugin_config_id: id });
          proxy.updated_at = stamp();
        }
      }
      return structuredClone(next);
    },
    deletePlugin: async (id) => {
      deleteCalls += 1;
      operations.push(`delete:${id}`);
      if (options.failPluginDelete) throw new Error("injected plugin delete failure");
      if (!plugins.has(id)) throw notFound(id);
      plugins.delete(id);
    },
  };

  return {
    deps,
    proxies,
    plugins,
    operations,
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
  it("rejects an empty group edit before it can remove the final reference", async () => {
    const state = harness([makeProxy("p1", ["plugin-1"])], [makePlugin("plugin-1")]);
    await expect(
      updatePluginWithMembership("plugin-1", groupInput(), [], state.deps),
    ).rejects.toThrow("require at least one proxy");
    expect(state.counts().updateProxyCalls).toBe(0);
    expect(state.counts().updatePluginCalls).toBe(0);
  });

  it("attaches the destination before detaching the sole source", async () => {
    const state = harness(
      [makeProxy("a-source", ["plugin-1"]), makeProxy("z-target")],
      [makePlugin("plugin-1")],
    );
    await updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["z-target"],
      state.deps,
    );
    expect(
      state.operations.filter((operation) => operation.startsWith("proxy:")),
    ).toEqual(["proxy:z-target", "proxy:a-source"]);
    expect(memberships(state.proxies, "plugin-1")).toEqual(["z-target"]);
    expect(state.plugins.get("plugin-1")?.config).toEqual({ requests: 20 });
    expect(state.operations).not.toContain("cascade:plugin-1");
  });

  it("reattaches original members before removing the destination on rollback", async () => {
    const state = harness(
      [
        makeProxy("p1", ["plugin-1"]),
        makeProxy("p2", ["plugin-1"]),
        makeProxy("p3", ["plugin-1"]),
        makeProxy("p4"),
      ],
      [makePlugin("plugin-1")],
      { failProxyOnce: "p3" },
    );
    await expect(
      updatePluginWithMembership("plugin-1", groupInput(), ["p4"], state.deps),
    ).rejects.toThrow("rollback was attempted");
    expect(
      state.operations.filter((operation) => operation.startsWith("proxy:")),
    ).toEqual([
      "proxy:p4",
      "proxy:p1",
      "proxy:p2",
      "proxy:p3",
      "proxy:p2",
      "proxy:p1",
      "proxy:p4",
    ]);
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p1", "p2", "p3"]);
    expect(state.plugins.get("plugin-1")?.config).toEqual({ requests: 10 });
    expect(state.operations).not.toContain("cascade:plugin-1");
  });

  it("retains the last destination if an originally orphaned group cannot converge", async () => {
    const state = harness(
      [makeProxy("p1"), makeProxy("p2")],
      [makePlugin("plugin-1")],
      { failProxyOnce: "p2" },
    );
    await expect(
      updatePluginWithMembership("plugin-1", groupInput(), ["p1", "p2"], state.deps),
    ).rejects.toThrow("proxy p1 was retained as the last reference");
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p1"]);
    expect(state.plugins.has("plugin-1")).toBe(true);
  });

  it("reports the remaining membership when compensation also fails", async () => {
    const state = harness(
      [
        makeProxy("p1", ["plugin-1"]),
        makeProxy("p2", ["plugin-1"]),
        makeProxy("p3"),
      ],
      [makePlugin("plugin-1")],
      { failProxyCalls: [3, 4] },
    );
    await expect(
      updatePluginWithMembership("plugin-1", groupInput(), ["p3"], state.deps),
    ).rejects.toThrow("remaining proxy references: p2");
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p2"]);
    expect(state.plugins.get("plugin-1")?.config).toEqual({ requests: 10 });
    expect(state.operations).not.toContain("cascade:plugin-1");
  });

  it("reports missing config and remaining references without reattaching a deleted plugin", async () => {
    const original = makePlugin("plugin-1");
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2"), makeProxy("p3")],
      [original],
      { failProxyOnce: "p3", losePluginOnFailure: "plugin-1" },
    );
    const error = await updatePluginWithMembership(
      "plugin-1",
      groupInput(),
      ["p2", "p3"],
      state.deps,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PluginMembershipError);
    expect((error as PluginMembershipError).message).toContain("GET returned 404");
    expect((error as PluginMembershipError).message).toContain(
      "remaining proxy references: none",
    );
    expect((error as PluginMembershipError).lastKnownConfig).toMatchObject({
      id: "plugin-1",
      config: original.config,
      scope: "proxy_group",
    });
    expect(state.counts().updateProxyCalls).toBe(2);
    expect(state.counts().updatePluginCalls).toBe(1);
  });

  it("verifies the final detach cascade as successful deletion without DELETE", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2", ["plugin-1"])],
      [makePlugin("plugin-1")],
      { failPluginDelete: true },
    );
    await deletePluginWithMembership("plugin-1", state.deps);
    expect(state.operations.slice(-2)).toEqual(["cascade:plugin-1", "get:plugin-1"]);
    expect(state.counts().deleteCalls).toBe(0);
    expect(state.plugins.has("plugin-1")).toBe(false);
    expect(memberships(state.proxies, "plugin-1")).toEqual([]);
  });

  it("models DELETE of an already cascade-deleted plugin as 404", async () => {
    const state = harness([makeProxy("p1", ["plugin-1"])], [makePlugin("plugin-1")]);
    await state.deps.updateProxy("p1", { ...makeProxy("p1"), plugins: [] });
    await expect(state.deps.deletePlugin("plugin-1")).rejects.toMatchObject({
      response: { status: 404 },
    });
  });

  it("explicitly deletes an existing group with no references", async () => {
    const state = harness([], [makePlugin("plugin-1")]);
    await deletePluginWithMembership("plugin-1", state.deps);
    expect(state.counts().deleteCalls).toBe(1);
    expect(state.plugins.has("plugin-1")).toBe(false);
  });

  it("reports explicit deletion failure when the unreferenced plugin still exists", async () => {
    const state = harness([], [makePlugin("plugin-1")], { failPluginDelete: true });
    await expect(deletePluginWithMembership("plugin-1", state.deps)).rejects.toThrow(
      "plugin plugin-1 exists with scope proxy_group",
    );
    expect(state.plugins.has("plugin-1")).toBe(true);
  });

  it("does not mistake a failed verification read for cascade confirmation", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"])],
      [makePlugin("plugin-1")],
      { failPluginGetCall: 2 },
    );
    await expect(deletePluginWithMembership("plugin-1", state.deps)).rejects.toThrow(
      "injected plugin read failure",
    );
    // Recovery probes see the missing config and never PUT a dangling reference.
    expect(state.counts().updateProxyCalls).toBe(1);
    expect(state.counts().deleteCalls).toBe(0);
  });

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
      const error = await createPluginWithMembership(
        groupInput(),
        ["p1", "p2", "p3"],
        state.deps,
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(PluginMembershipError);
      expect((error as PluginMembershipError).recovery).toEqual([]);
      expect(memberships(state.proxies, "created-plugin")).toEqual([]);
      expect(state.plugins.has("created-plugin")).toBe(false);
      expect(state.counts().deleteCalls).toBe(failureId === "p1" ? 1 : 0);
    },
  );

  it("preserves a concurrently edited new config during creation rollback", async () => {
    const state = harness([makeProxy("p1"), makeProxy("p2")]);
    const updateProxy = state.deps.updateProxy;
    state.deps.updateProxy = async (id, data) => {
      if (id === "p2") {
        await state.deps.updatePlugin("created-plugin", {
          ...groupInput(),
          config: { requests: 99 },
        });
        throw new Error("injected failure after concurrent config edit");
      }
      return updateProxy(id, data);
    };
    await expect(
      createPluginWithMembership(groupInput(), ["p1", "p2"], state.deps),
    ).rejects.toThrow("proxy p1 was retained as the last reference");
    expect(state.plugins.get("created-plugin")?.config).toEqual({ requests: 99 });
    expect(memberships(state.proxies, "created-plugin")).toEqual(["p1"]);
    expect(state.counts().deleteCalls).toBe(0);
  });

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

  it.each(["global", "proxy"] as const)(
    "restores %s scope atomically before group rollback can cascade",
    async (scope) => {
      const state = harness(
        [
          makeProxy("p1", scope === "proxy" ? ["plugin-1"] : []),
          makeProxy("p2"),
          makeProxy("p3"),
        ],
        [
          {
            ...makePlugin("plugin-1", scope),
            proxy_id: scope === "proxy" ? "p1" : undefined,
          },
        ],
        { failProxyOnce: "p3" },
      );
      await expect(
        updatePluginWithMembership(
          "plugin-1",
          groupInput(),
          ["p2", "p3"],
          state.deps,
        ),
      ).rejects.toThrow("rollback was attempted");
      expect(state.plugins.get("plugin-1")?.scope).toBe(scope);
      expect(memberships(state.proxies, "plugin-1")).toEqual(
        scope === "proxy" ? ["p1"] : [],
      );
      expect(state.operations).not.toContain("cascade:plugin-1");
    },
  );

  it.each(["global", "proxy"] as const)(
    "uses atomic plugin PUT for a group-to-%s transition",
    async (scope) => {
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
        { ...groupInput(scope), ...(scope === "proxy" ? { proxy_id: "p3" } : {}) },
        [],
        state.deps,
      );
      expect(memberships(state.proxies, "plugin-1")).toEqual(
        scope === "proxy" ? ["p3"] : [],
      );
      expect(state.plugins.get("plugin-1")?.scope).toBe(scope);
      expect(state.counts().updateProxyCalls).toBe(0);
      expect(state.operations).not.toContain("cascade:plugin-1");
    },
  );

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

  it("restores membership when a detach fails during deletion", async () => {
    const state = harness(
      [makeProxy("p1", ["plugin-1"]), makeProxy("p2", ["plugin-1"])],
      [makePlugin("plugin-1")],
      { failProxyOnce: "p2" },
    );
    await expect(deletePluginWithMembership("plugin-1", state.deps)).rejects.toThrow(
      "rollback was attempted",
    );
    expect(memberships(state.proxies, "plugin-1")).toEqual(["p1", "p2"]);
    expect(state.plugins.has("plugin-1")).toBe(true);
  });
});
