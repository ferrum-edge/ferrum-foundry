import { describe, expect, it } from "vitest";
import type { Consumer, PluginConfig, Proxy } from "@/api/types";
import { pluginAppliesToProxy } from "./pluginProtocols";
import {
  analyzeProxyPolicy,
  effectivePluginsForProxy,
  inapplicablePluginsForProxy,
  pluginAttachmentIndex,
  resolveConsumerAccess,
  type EffectivePlugin,
} from "./effectivePolicy";

function proxy(overrides: Partial<Proxy> = {}): Proxy {
  return {
    id: "proxy-1",
    backend_host: "backend",
    backend_port: 443,
    hosts: [],
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 1_000,
    backend_read_timeout_ms: 1_000,
    backend_write_timeout_ms: 1_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [{ plugin_config_id: "group-acl" }],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function plugin(
  id: string,
  pluginName: string,
  scope: PluginConfig["scope"],
  config: Record<string, unknown> = {},
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  return {
    id,
    plugin_name: pluginName,
    scope,
    config,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function consumer(
  id: string,
  username: string,
  groups: string[],
  credentials: Consumer["credentials"],
): Consumer {
  return {
    id,
    username,
    acl_groups: groups,
    credentials,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * A whole-collection oracle written from the gateway's scope merge (Ferrum
 * Edge v0.9.7 `src/plugin_cache.rs`: `remove_shadowed_global_plugin` and
 * `is_istio_route_transform_consumer`), not from the indexed implementation.
 * It scans the collection once for the scoped configurations this proxy
 * actually merges, drops every global those shadow by plugin name (size
 * limiters and the exact Istio route-transform consumer are additive), and
 * orders by priority then id. The indexed path must return the same plugins,
 * ordering, and sources.
 */
function referenceAttachedPlugins(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  const associated = new Set(
    (proxy.plugins ?? []).map((association) => association.plugin_config_id),
  );
  const merged = pluginConfigs.filter((plugin) => {
    if (!plugin.enabled || plugin.scope === "global") return false;
    if (!associated.has(plugin.id)) return false;
    if (plugin.scope === "proxy") return plugin.proxy_id === proxy.id;
    return plugin.proxy_id == null;
  });
  const istioPrefix: Record<string, string> = {
    request_transformer: "istio-vs-req-xform-",
    response_transformer: "istio-vs-resp-xform-",
  };
  const shadowedNames = new Set(
    merged
      .filter((plugin) => {
        if (["request_size_limiting", "response_size_limiting"].includes(plugin.plugin_name)) {
          return false;
        }
        const prefix = istioPrefix[plugin.plugin_name];
        const rules = plugin.config.rules;
        const istio =
          plugin.scope === "proxy" &&
          prefix !== undefined &&
          plugin.id === `${prefix}${proxy.id}` &&
          Array.isArray(rules) &&
          rules.length === 0 &&
          plugin.config.apply_route_overrides === true;
        return !istio;
      })
      .map((plugin) => plugin.plugin_name),
  );

  return pluginConfigs
    .filter((plugin) => {
      if (!plugin.enabled) return false;
      if (plugin.scope === "global") return !shadowedNames.has(plugin.plugin_name);
      return merged.includes(plugin);
    })
    .map((plugin) => ({ ...plugin, effectiveSource: plugin.scope }))
    .sort(
      (left, right) =>
        (left.priority_override ?? Number.MAX_SAFE_INTEGER) -
          (right.priority_override ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
}

describe("effective authorization policy", () => {
  it.each([{}, { keyauth: [] }, { jwt: [{ secret: "[REDACTED]" }] }])(
    "treats omitted basic credentials as unobservable, including unrelated credentials: %j",
    (credentials) => {
      const analysis = analyzeProxyPolicy(proxy(), [
        plugin("basic", "basic_auth", "global"),
      ], [consumer("1", "alice", [], credentials)]);
      expect(analysis.authPlugins.map((p) => p.plugin_name)).toEqual(["basic_auth"]);
      expect(analysis.conditional).toBe(true);
      expect(analysis.reasons.join(" ")).toContain("ordinary Consumer responses omit basicauth");
      expect(analysis.consumers[0]?.decision).toBe("conditional");
      expect(analysis.consumers[0]?.reasons.join(" ")).toContain("presence is unknown");
    },
  );

  it("preserves observed key-auth decisions and treats mixed missing auth as unknown", () => {
    const people = [
      consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("2", "bob", [], {}),
    ];
    const key = plugin("key", "key_auth", "global", {}, { priority_override: 10 });
    const basic = plugin("basic", "basic_auth", "global", {}, { priority_override: 20 });
    expect(analyzeProxyPolicy(proxy(), [key], people).consumers.map((c) => c.decision))
      .toEqual(["allowed", "denied"]);
    const mixed = analyzeProxyPolicy(proxy(), [key, basic], people);
    expect(mixed.consumers.map((c) => c.decision)).toEqual(["allowed", "conditional"]);
    expect(mixed.consumers[0]?.reasons).toEqual(["Matching credential for key_auth"]);

    const unordered = analyzeProxyPolicy(proxy(), [key, { ...basic, priority_override: null }], people);
    expect(unordered.consumers[0]?.decision).toBe("conditional");
    expect(unordered.consumers[0]?.reasons.join(" ")).toContain("execution order");
  });

  it.each([
    { disallowed_consumers: ["alice"] },
    { disallowed_groups: ["blocked"] },
    { allowed_consumers: ["bob"] },
  ])("keeps explicit ACL denial ahead of unknown basic auth: %j", (acl) => {
    const analysis = analyzeProxyPolicy(proxy(), [
      plugin("basic", "basic_auth", "global"),
      plugin("acl", "access_control", "global", acl),
    ], [consumer("1", "alice", ["blocked"], {})]);
    expect(analysis.consumers[0]?.decision).toBe("denied");
    expect(analysis.consumers[0]?.reasons.join(" ")).not.toContain("credential");
  });

  it("retains trigger and external reasons alongside unknown local knowledge", () => {
    const analysis = analyzeProxyPolicy(proxy(), [
      plugin("basic", "basic_auth", "global", {}, {
        trigger: { when: { match: { path: { prefix: ["/private"] } } } },
      }),
      plugin("external", "jwks_auth", "global"),
      plugin("acl", "access_control", "global", { disallowed_consumers: ["alice"] }, {
        trigger: { when: { match: { path: { prefix: ["/admin"] } } } },
      }),
    ], [consumer("1", "alice", [], {})]);
    const result = analysis.consumers[0]!;
    expect(result.decision).toBe("conditional");
    for (const reason of ["omit basicauth", "External identity", "authentication plugins have request-dependent", "access-control trigger", "execution order"]) {
      expect(result.reasons.join(" ")).toContain(reason);
    }
  });

  it("includes enabled global, direct, and associated group plugins", () => {
    const plugins = [
      plugin("global-auth", "key_auth", "global"),
      plugin("direct-auth", "jwt_auth", "proxy", {}, { proxy_id: "proxy-1" }),
      plugin("other-direct", "basic_auth", "proxy", {}, { proxy_id: "proxy-2" }),
      plugin("group-acl", "access_control", "proxy_group"),
      plugin("disabled", "hmac_auth", "global", {}, { enabled: false }),
    ];
    const attached = proxy({
      plugins: [{ plugin_config_id: "group-acl" }, { plugin_config_id: "direct-auth" }],
    });
    expect(effectivePluginsForProxy(attached, plugins).map((entry) => entry.id)).toEqual([
      "direct-auth",
      "global-auth",
      "group-acl",
    ]);
  });

  it("does not count a proxy-scoped plugin the proxy does not list", () => {
    // `proxy_id` records intent; the gateway runs the plugin only when the
    // proxy's own `plugins` names it. An orphan must not read as protection.
    const plugins = [plugin("orphan-auth", "key_auth", "proxy", {}, { proxy_id: "proxy-1" })];
    const bare = proxy({ plugins: [] });
    expect(effectivePluginsForProxy(bare, plugins)).toEqual([]);
    expect(analyzeProxyPolicy(bare, plugins, [consumer("1", "alice", [], {})]).consumers[0]!.decision)
      .toBe("public");
  });

  it.each(["proxy-1", ""])(
    "does not count an attached proxy-group plugin with proxy_id %j",
    (proxyId) => {
      const target = proxy({ plugins: [{ plugin_config_id: "group-acl" }] });
      const plugins = [
        plugin("global-acl", "access_control", "global", {
          disallowed_consumers: ["alice"],
        }),
        plugin(
          "group-acl",
          "access_control",
          "proxy_group",
          { allowed_consumers: ["alice"] },
          { proxy_id: proxyId },
        ),
      ];

      expect(effectivePluginsForProxy(target, plugins).map((entry) => entry.id)).toEqual([
        "global-acl",
      ]);
      expect(
        analyzeProxyPolicy(target, plugins, [consumer("1", "alice", [], {})]).consumers[0]
          ?.decision,
      ).toBe("denied");
    },
  );

  it("does not count HTTP-only plugins as effective on a stream proxy", () => {
    const plugins = [
      plugin("global-cors", "cors", "global"),
      plugin("global-logging", "stdout_logging", "global"),
    ];
    const httpProxy = proxy({ plugins: [] });
    const streamProxy = proxy({
      backend_scheme: "tcp",
      listen_port: 18_443,
      listen_path: null,
      plugins: [],
    });

    expect(effectivePluginsForProxy(httpProxy, plugins).map((p) => p.id)).toEqual([
      "global-cors",
      "global-logging",
    ]);
    expect(inapplicablePluginsForProxy(httpProxy, plugins)).toEqual([]);

    expect(effectivePluginsForProxy(streamProxy, plugins).map((p) => p.id)).toEqual([
      "global-logging",
    ]);
    expect(inapplicablePluginsForProxy(streamProxy, plugins).map((p) => p.id)).toEqual([
      "global-cors",
    ]);
  });

  it("reports no authentication for a stream proxy whose only auth plugin is HTTP-only", () => {
    const streamProxy = proxy({
      backend_scheme: "tcp",
      listen_port: 18_443,
      listen_path: null,
      plugins: [],
    });
    const analysis = analyzeProxyPolicy(
      streamProxy,
      [plugin("global-jwt", "jwt_auth", "global")],
      [consumer("1", "alice", [], { jwt: [{ secret: "[REDACTED]" }] })],
    );
    expect(analysis.effectivePlugins).toEqual([]);
    expect(analysis.authPlugins).toEqual([]);
    expect(analysis.consumers[0]?.decision).toBe("public");
  });

  it("implements canonical consumer/group allow fields with deny precedence", () => {
    const plugins = [
      plugin("auth", "key_auth", "global"),
      plugin("group-acl", "access_control", "proxy_group", {
        allowed_consumers: ["alice"],
        allowed_groups: ["operators"],
        disallowed_consumers: ["mallory"],
        disallowed_groups: ["suspended"],
      }),
    ];
    const analysis = analyzeProxyPolicy(proxy(), plugins, [
      consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("2", "bob", ["operators"], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("3", "mallory", ["operators"], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("4", "carol", ["suspended", "operators"], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("5", "dave", [], { keyauth: [{ key: "[REDACTED]" }] }),
    ]);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual([
      "allowed",
      "allowed",
      "denied",
      "denied",
      "denied",
    ]);
  });

  it("marks OAuth2, OIDC, JWKS, LDAP, SPIFFE, SOAP, and triggers conditional", () => {
    for (const pluginName of [
      "oauth2_introspection",
      "oidc_relying_party",
      "jwks_auth",
      "ldap_auth",
      "spiffe_identity",
      "soap_ws_security",
    ]) {
      const analysis = analyzeProxyPolicy(proxy({ plugins: [] }), [
        plugin(
          "external",
          pluginName,
          "global",
          pluginName === "soap_ws_security" ? { saml: { enabled: true } } : {},
        ),
      ], [consumer("1", "alice", [], {})]);
      expect(analysis.consumers[0]?.decision, pluginName).toBe("conditional");
    }

    const triggered = analyzeProxyPolicy(proxy({ plugins: [] }), [
      plugin("auth", "key_auth", "global", {}, {
        trigger: { when: { match: { path: { prefix: ["/admin"] } } } },
      }),
    ], [consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] })]);
    expect(triggered.consumers[0]?.decision).toBe("conditional");
  });

  it("does not misclassify timestamp-only SOAP validation as authentication", () => {
    const analysis = analyzeProxyPolicy(proxy({ plugins: [] }), [
      plugin("soap", "soap_ws_security", "global", {
        timestamp: { require: true },
      }),
    ], [consumer("1", "alice", [], {})]);
    expect(analysis.authPlugins).toEqual([]);
    expect(analysis.consumers[0]?.decision).toBe("public");
  });

  it("does not label a credential-less consumer as authorized", () => {
    const analysis = analyzeProxyPolicy(proxy({ plugins: [] }), [
      plugin("auth", "jwt_auth", "global"),
    ], [consumer("1", "alice", [], {})]);
    expect(analysis.consumers[0]?.decision).toBe("denied");
  });

  it("does not turn a triggered ACL into a definitive allow or deny", () => {
    const analysis = analyzeProxyPolicy(proxy(), [
      plugin("auth", "key_auth", "global"),
      plugin("group-acl", "access_control", "proxy_group", {
        disallowed_consumers: ["alice"],
      }, {
        trigger: { when: { match: { path: { prefix: ["/admin"] } } } },
      }),
    ], [consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] })]);
    expect(analysis.consumers[0]?.decision).toBe("conditional");
  });

  it("resolves each proxy identically to the gateway scope merge on a mixed fixture", () => {
    const plugins = [
      plugin("global-auth", "key_auth", "global", {}, { priority_override: 30 }),
      plugin("global-logging", "stdout_logging", "global"),
      plugin("global-cors", "cors", "global"),
      plugin("direct-p1", "jwt_auth", "proxy", {}, { proxy_id: "p1", priority_override: 10 }),
      plugin("direct-p2", "key_auth", "proxy", {}, { proxy_id: "p2", priority_override: 5 }),
      plugin("group-acl", "access_control", "proxy_group", {}, { priority_override: 20 }),
      plugin("group-rate", "rate_limiting", "proxy_group"),
      plugin("group-unattached", "hmac_auth", "proxy_group", {}, { priority_override: 1 }),
      plugin("disabled-global", "basic_auth", "global", {}, { enabled: false }),
    ];
    const fixtures: Proxy[] = [
      proxy({
        id: "p1",
        plugins: [
          { plugin_config_id: "direct-p1" },
          { plugin_config_id: "group-acl" },
          // Targets p2: `proxy_id` is intent, not attachment to p1.
          { plugin_config_id: "direct-p2" },
          { plugin_config_id: "disabled-global" },
        ],
      }),
      proxy({
        id: "p2",
        plugins: [
          { plugin_config_id: "direct-p2" },
          { plugin_config_id: "group-rate" },
          { plugin_config_id: "missing" },
        ],
      }),
      proxy({
        id: "s1",
        backend_scheme: "tcp",
        listen_port: 18_443,
        listen_path: null,
        plugins: [
          { plugin_config_id: "direct-p1" },
          { plugin_config_id: "group-acl" },
          { plugin_config_id: "group-rate" },
        ],
      }),
    ];
    const expectedAttached: Record<string, string[]> = {
      p1: ["direct-p1", "group-acl", "global-auth", "global-cors", "global-logging"],
      // p2's attached direct key_auth shadows the global key_auth. p1 lists
      // direct-p2 too, but it targets p2, so p1 keeps the global instance.
      p2: ["direct-p2", "global-cors", "global-logging", "group-rate"],
      s1: ["group-acl", "global-auth", "global-cors", "global-logging", "group-rate"],
    };
    // A stream proxy runs only the stream-capable plugins it is attached to.
    const expectedEffective: Record<string, string[]> = {
      p1: expectedAttached.p1,
      p2: expectedAttached.p2,
      s1: ["group-acl", "global-logging", "group-rate"],
    };
    const consumers = [
      consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("2", "bob", ["operators"], {}),
      consumer("3", "carol", ["suspended"], { jwt: [{ secret: "[REDACTED]" }] }),
    ];

    for (const fixture of fixtures) {
      const reference = referenceAttachedPlugins(fixture, plugins);
      const referenceEffective = reference.filter((entry) =>
        pluginAppliesToProxy(entry.plugin_name, fixture),
      );
      const referenceInapplicable = reference.filter(
        (entry) => !pluginAppliesToProxy(entry.plugin_name, fixture),
      );

      expect(reference.map((entry) => entry.id), fixture.id).toEqual(expectedAttached[fixture.id]);
      expect(
        effectivePluginsForProxy(fixture, plugins).map((entry) => entry.id),
        fixture.id,
      ).toEqual(expectedEffective[fixture.id]);
      expect(
        inapplicablePluginsForProxy(fixture, plugins).map((entry) => entry.id),
        fixture.id,
      ).toEqual(referenceInapplicable.map((entry) => entry.id));

      const analysis = analyzeProxyPolicy(fixture, plugins, consumers);
      expect(analysis.effectivePlugins, fixture.id).toEqual(
        effectivePluginsForProxy(fixture, plugins),
      );
      expect(analysis.consumers, fixture.id).toEqual(
        consumers.map((entry) => resolveConsumerAccess(fixture, referenceEffective, entry)),
      );
    }
  });

  it("reuses one index build while resolving many proxies from an unchanged collection", () => {
    let elementReads = 0;
    const raw = Array.from({ length: 600 }, (_, index) =>
      plugin(
        `config-${index}`,
        index % 2 === 0 ? "key_auth" : "rate_limiting",
        index % 3 === 0 ? "global" : "proxy_group",
      ),
    );
    // A read of any element means the collection was traversed. The index
    // build reads every element once; nothing after it may read the
    // collection again, no matter how many proxies are resolved.
    const counted = new Proxy(raw, {
      get(target, property, receiver) {
        if (typeof property === "string" && Number.isInteger(Number(property))) {
          elementReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as PluginConfig[];

    const index = pluginAttachmentIndex(counted);
    expect(elementReads).toBeGreaterThan(0);
    const readsAfterBuild = elementReads;
    expect(pluginAttachmentIndex(counted)).toBe(index);

    // Re-rendering and resolving a policy for every proxy on screen must not
    // rescan the collection once per proxy.
    for (let i = 0; i < 600; i += 1) {
      const target = proxy({
        id: `proxy-${i}`,
        plugins: [{ plugin_config_id: `config-${i}` }],
      });
      expect(effectivePluginsForProxy(target, counted)).toBeDefined();
      expect(inapplicablePluginsForProxy(target, counted)).toBeDefined();
      expect(analyzeProxyPolicy(target, counted, [consumer("1", "alice", [], {})])).toBeDefined();
    }
    expect(elementReads).toBe(readsAfterBuild);
  });
});

describe("gateway scope merge: scoped instances shadow same-name globals", () => {
  const alice = consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] });
  const ids = (plugins: EffectivePlugin[]) => plugins.map((entry) => entry.id);
  const allowAlice = { allowed_consumers: ["alice"] };

  function expectOracleParity(target: Proxy, plugins: PluginConfig[]) {
    const reference = referenceAttachedPlugins(target, plugins);
    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual(
      ids(reference.filter((entry) => pluginAppliesToProxy(entry.plugin_name, target))),
    );
    expect(ids(inapplicablePluginsForProxy(target, plugins))).toEqual(
      ids(reference.filter((entry) => !pluginAppliesToProxy(entry.plugin_name, target))),
    );
  }

  it("lets an attached proxy-scoped ACL replace the global ACL (#469 reproduction)", () => {
    const plugins = [
      plugin("global-key", "key_auth", "global"),
      plugin("global-acl", "access_control", "global", { disallowed_consumers: ["alice"] }),
      plugin("scoped-acl", "access_control", "proxy", allowAlice, {
        proxy_id: "p",
      }),
    ];
    const target = proxy({ id: "p", plugins: [{ plugin_config_id: "scoped-acl" }] });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual(["global-key", "scoped-acl"]);
    const analysis = analyzeProxyPolicy(target, plugins, [alice]);
    expect(ids(analysis.accessControlPlugins)).toEqual(["scoped-acl"]);
    expect(analysis.consumers[0]?.decision).toBe("allowed");
    expect(analysis.consumers[0]?.reasons.join(" ")).not.toContain("global-acl");
    expectOracleParity(target, plugins);
  });

  it("lets an attached proxy-group ACL replace the global ACL", () => {
    const plugins = [
      plugin("global-key", "key_auth", "global"),
      plugin("global-acl", "access_control", "global", { allowed_consumers: ["bob"] }),
      plugin("group-acl", "access_control", "proxy_group", allowAlice),
      plugin("global-rate", "rate_limiting", "global"),
      plugin("group-rate", "rate_limiting", "proxy_group"),
    ];
    const target = proxy({
      plugins: [{ plugin_config_id: "group-acl" }, { plugin_config_id: "group-rate" }],
    });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([
      "global-key",
      "group-acl",
      "group-rate",
    ]);
    expect(analyzeProxyPolicy(target, plugins, [alice]).consumers[0]?.decision).toBe("allowed");
    expectOracleParity(target, plugins);
  });

  it("keeps globals whose name no attached scoped instance shares", () => {
    const plugins = [
      plugin("global-key", "key_auth", "global"),
      plugin("global-acl", "access_control", "global", { disallowed_consumers: ["alice"] }),
      plugin("scoped-rate", "rate_limiting", "proxy", {}, { proxy_id: "proxy-1" }),
    ];
    const target = proxy({ plugins: [{ plugin_config_id: "scoped-rate" }] });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([
      "global-acl",
      "global-key",
      "scoped-rate",
    ]);
    expect(analyzeProxyPolicy(target, plugins, [alice]).consumers[0]?.decision).toBe("denied");
    expectOracleParity(target, plugins);
  });

  it.each([
    {
      label: "a disabled proxy-scoped instance",
      scoped: plugin("scoped-acl", "access_control", "proxy", allowAlice, {
        proxy_id: "proxy-1",
        enabled: false,
      }),
      attach: ["scoped-acl"],
    },
    {
      label: "a disabled proxy-group instance",
      scoped: plugin("group-acl", "access_control", "proxy_group", allowAlice, {
        enabled: false,
      }),
      attach: ["group-acl"],
    },
    {
      label: "a proxy-scoped instance the proxy does not list",
      scoped: plugin("scoped-acl", "access_control", "proxy", allowAlice, {
        proxy_id: "proxy-1",
      }),
      attach: [],
    },
    {
      label: "a proxy-group instance the proxy does not list",
      scoped: plugin("group-acl", "access_control", "proxy_group", allowAlice),
      attach: [],
    },
    {
      label: "a listed proxy-scoped instance that targets another proxy",
      scoped: plugin("scoped-acl", "access_control", "proxy", allowAlice, {
        proxy_id: "proxy-2",
      }),
      attach: ["scoped-acl"],
    },
  ])("does not shadow the global ACL with $label", ({ scoped, attach }) => {
    const plugins = [
      plugin("global-key", "key_auth", "global"),
      plugin("global-acl", "access_control", "global", { disallowed_consumers: ["alice"] }),
      scoped,
    ];
    const target = proxy({ plugins: attach.map((id) => ({ plugin_config_id: id })) });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual(["global-acl", "global-key"]);
    const analysis = analyzeProxyPolicy(target, plugins, [alice]);
    expect(analysis.consumers[0]?.decision).toBe("denied");
    expect(analysis.consumers[0]?.reasons).toEqual(["global-acl explicitly denies consumer alice"]);
    expectOracleParity(target, plugins);
  });

  it.each(["request_size_limiting", "response_size_limiting"])(
    "keeps a global %s beside same-name scoped instances",
    (pluginName) => {
      const plugins = [
        plugin("global-limit", pluginName, "global"),
        plugin("scoped-limit", pluginName, "proxy", {}, { proxy_id: "proxy-1" }),
        plugin("group-limit", pluginName, "proxy_group"),
      ];
      const target = proxy({
        plugins: [{ plugin_config_id: "scoped-limit" }, { plugin_config_id: "group-limit" }],
      });

      expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([
        "global-limit",
        "group-limit",
        "scoped-limit",
      ]);
      expectOracleParity(target, plugins);
    },
  );

  it.each([
    ["request_transformer", "istio-vs-req-xform-proxy-1"],
    ["response_transformer", "istio-vs-resp-xform-proxy-1"],
  ])("keeps a global %s beside the exact Istio route-transform consumer", (pluginName, id) => {
    const plugins = [
      plugin("global-xform", pluginName, "global", { rules: [{ op: "add" }] }),
      plugin(id, pluginName, "proxy", { rules: [], apply_route_overrides: true }, {
        proxy_id: "proxy-1",
      }),
    ];
    const target = proxy({ plugins: [{ plugin_config_id: id }] });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual(["global-xform", id]);
    expectOracleParity(target, plugins);
  });

  it.each([
    {
      label: "static rules",
      pluginName: "request_transformer",
      id: "istio-vs-req-xform-proxy-1",
      config: { rules: [{ op: "add" }], apply_route_overrides: true },
    },
    {
      label: "route overrides off",
      pluginName: "request_transformer",
      id: "istio-vs-req-xform-proxy-1",
      config: { rules: [], apply_route_overrides: false },
    },
    {
      label: "route overrides omitted",
      pluginName: "response_transformer",
      id: "istio-vs-resp-xform-proxy-1",
      config: { rules: [] },
    },
    {
      label: "rules omitted",
      pluginName: "request_transformer",
      id: "istio-vs-req-xform-proxy-1",
      config: { apply_route_overrides: true },
    },
    {
      label: "an id for another proxy",
      pluginName: "request_transformer",
      id: "istio-vs-req-xform-proxy-2",
      config: { rules: [], apply_route_overrides: true },
    },
    {
      label: "the other transformer's prefix",
      pluginName: "response_transformer",
      id: "istio-vs-req-xform-proxy-1",
      config: { rules: [], apply_route_overrides: true },
    },
    {
      label: "an ordinary operator id",
      pluginName: "request_transformer",
      id: "my-xform",
      config: { rules: [], apply_route_overrides: true },
    },
  ])("shadows a global transformer with a near-Istio instance: $label", ({
    pluginName,
    id,
    config,
  }) => {
    const plugins = [
      plugin("global-xform", pluginName, "global", { rules: [{ op: "add" }] }),
      plugin(id, pluginName, "proxy", config, { proxy_id: "proxy-1" }),
    ];
    const target = proxy({ plugins: [{ plugin_config_id: id }] });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([id]);
    expectOracleParity(target, plugins);
  });

  it("shadows a global transformer with a proxy-group instance using an Istio-shaped id", () => {
    const id = "istio-vs-req-xform-proxy-1";
    const plugins = [
      plugin("global-xform", "request_transformer", "global", { rules: [{ op: "add" }] }),
      plugin(id, "request_transformer", "proxy_group", { rules: [], apply_route_overrides: true }),
    ];
    const target = proxy({ plugins: [{ plugin_config_id: id }] });

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([id]);
    expectOracleParity(target, plugins);
  });

  it("merges scopes before the protocol filter on a stream proxy", () => {
    const plugins = [
      plugin("global-cors", "cors", "global"),
      plugin("group-cors", "cors", "proxy_group"),
      plugin("global-logging", "stdout_logging", "global"),
    ];
    const streamProxy = proxy({
      backend_scheme: "tcp",
      listen_port: 18_443,
      listen_path: null,
      plugins: [{ plugin_config_id: "group-cors" }],
    });

    expect(ids(effectivePluginsForProxy(streamProxy, plugins))).toEqual(["global-logging"]);
    // The shadowed global is neither run nor reported as skipped.
    expect(ids(inapplicablePluginsForProxy(streamProxy, plugins))).toEqual(["group-cors"]);
    expectOracleParity(streamProxy, plugins);
  });

  it("resolves the same shadowing from every proxy against one shared index", () => {
    const plugins = [
      plugin("global-key", "key_auth", "global"),
      plugin("global-acl", "access_control", "global", { disallowed_consumers: ["alice"] }),
      plugin("group-acl", "access_control", "proxy_group", allowAlice),
    ];
    const shadowedProxy = proxy({ id: "p1", plugins: [{ plugin_config_id: "group-acl" }] });
    const plainProxy = proxy({ id: "p2", plugins: [] });

    // Shadowing is per proxy: it must never leak into the shared index.
    expect(analyzeProxyPolicy(shadowedProxy, plugins, [alice]).consumers[0]?.decision).toBe(
      "allowed",
    );
    expect(analyzeProxyPolicy(plainProxy, plugins, [alice]).consumers[0]?.decision).toBe("denied");
    expect(pluginAttachmentIndex(plugins).globals.map((entry) => entry.id)).toEqual([
      "global-key",
      "global-acl",
    ]);
    expect(analyzeProxyPolicy(shadowedProxy, plugins, [alice]).consumers[0]?.decision).toBe(
      "allowed",
    );
  });
});
