import { describe, expect, it } from "vitest";
import type { Consumer, PluginConfig, Proxy } from "@/api/types";
import { PLUGIN_DEFAULT_PRIORITY } from "./pluginChainOrder";
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
 * Edge v0.9.21 `src/plugin_cache.rs`: `remove_shadowed_globals`,
 * `is_istio_route_transform_consumer` and `plugin_chain_order`), not from the
 * indexed implementation. It scans the collection once for the scoped
 * configurations this proxy actually merges, drops every global those shadow
 * by plugin name (size limiters and the exact Istio route-transform consumer
 * are additive), assembles globals, proxy-scoped and proxy-group
 * configurations each in ascending id, and sorts that stably by effective
 * priority and then plugin name. The indexed path must return the same
 * plugins, ordering, and sources.
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

  const byId = (left: PluginConfig, right: PluginConfig) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  const assembled = [
    ...pluginConfigs
      .filter((plugin) => plugin.enabled && plugin.scope === "global")
      .filter((plugin) => !shadowedNames.has(plugin.plugin_name))
      .sort(byId),
    ...merged.filter((plugin) => plugin.scope === "proxy").sort(byId),
    ...merged.filter((plugin) => plugin.scope === "proxy_group").sort(byId),
  ];
  const priorityOf = (plugin: PluginConfig) =>
    plugin.priority_override ?? PLUGIN_DEFAULT_PRIORITY.get(plugin.plugin_name) ?? Infinity;
  return assembled
    .map((plugin, index) => ({ plugin, index }))
    .sort((left, right) =>
      priorityOf(left.plugin) - priorityOf(right.plugin) ||
      (left.plugin.plugin_name < right.plugin.plugin_name ? -1
        : left.plugin.plugin_name > right.plugin.plugin_name ? 1 : 0) ||
      left.index - right.index,
    )
    .map(({ plugin }) => ({ ...plugin, effectiveSource: plugin.scope }));
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

    // Without an override basic_auth keeps its default priority (1300), so
    // key_auth (10) still runs first and Alice's key settles it.
    const unordered = analyzeProxyPolicy(proxy(), [key, { ...basic, priority_override: null }], people);
    expect(unordered.consumers[0]?.decision).toBe("allowed");
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
    for (const reason of ["omit basicauth", "External identity", "authentication plugins have request-dependent", "access-control trigger", "single auth mode"]) {
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
      // Ferrum Edge v0.9.21 merges a proxy-group config only when `proxy_id`
      // is absent, so the excluded group ACL must neither apply nor shadow
      // the global ACL. Alice holds a key-auth credential: were the group
      // ACL merged, it would replace the global deny and she would read as
      // allowed; the deny must come from the global ACL itself.
      const target = proxy({ plugins: [{ plugin_config_id: "group-acl" }] });
      const plugins = [
        plugin("global-auth", "key_auth", "global"),
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
      const alice = consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] });

      expect(effectivePluginsForProxy(target, plugins).map((entry) => entry.id)).toEqual([
        "global-auth",
        "global-acl",
      ]);
      const result = analyzeProxyPolicy(target, plugins, [alice]).consumers[0];
      expect(result?.decision).toBe("denied");
      expect(result?.reasons).toEqual(["global-acl explicitly denies consumer alice"]);

      // Control: with the group config eligible it shadows the global deny.
      const eligible = plugins.map((entry) =>
        entry.id === "group-acl" ? { ...entry, proxy_id: null } : entry,
      );
      expect(analyzeProxyPolicy(target, eligible, [alice]).consumers[0]?.decision).toBe(
        "allowed",
      );
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

  it("counts the stream plugins Edge runs, and waf only with stream inspection (#636)", () => {
    const plugins = [
      plugin("global-fault", "fault_injection", "global", { stream_abort_percent: 100 }),
      plugin("global-chargeback", "api_chargeback", "global"),
      plugin("global-alerts", "proxy_alerts", "global"),
      plugin("global-waf-http", "waf", "global", { mode: "enforce" }),
      plugin("group-waf-stream", "waf", "proxy_group", {
        stream: { signatures: [{ id: "sig-1", pattern: "^EVIL" }] },
      }),
      plugin("group-waf-disabled", "waf", "proxy_group", {
        mode: "disabled", stream: { tcp_require_tls: true },
      }),
    ];
    const streamProxy = (id: string, attached: string[]) => proxy({
      id,
      backend_scheme: "tcp",
      listen_port: 18_443,
      listen_path: null,
      plugins: attached.map((plugin_config_id) => ({ plugin_config_id })),
    });
    const always = ["global-fault", "global-chargeback", "global-alerts"];
    const cases: [Proxy, string[], string[]][] = [
      // The attached stream WAF shadows the global HTTP-only one and runs.
      [streamProxy("waf-stream", ["group-waf-stream"]), [...always, "group-waf-stream"], []],
      [streamProxy("waf-disabled", ["group-waf-disabled"]), always, ["group-waf-disabled"]],
      [streamProxy("waf-http", []), always, ["global-waf-http"]],
    ];
    const sortedIds = (entries: EffectivePlugin[]) => entries.map((entry) => entry.id).sort();
    for (const [target, effective, skipped] of cases) {
      expect(sortedIds(effectivePluginsForProxy(target, plugins)), target.id).toEqual([...effective].sort());
      expect(sortedIds(inapplicablePluginsForProxy(target, plugins)), target.id).toEqual([...skipped].sort());
    }
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
      p2: ["direct-p2", "global-cors", "group-rate", "global-logging"],
      s1: ["group-acl", "global-auth", "global-cors", "group-rate", "global-logging"],
    };
    // A stream proxy runs only the stream-capable plugins it is attached to.
    const expectedEffective: Record<string, string[]> = {
      p1: expectedAttached.p1,
      p2: expectedAttached.p2,
      s1: ["group-acl", "group-rate", "global-logging"],
    };
    const consumers = [
      consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] }),
      consumer("2", "bob", ["operators"], {}),
      consumer("3", "carol", ["suspended"], { jwt: [{ secret: "[REDACTED]" }] }),
    ];

    for (const fixture of fixtures) {
      const reference = referenceAttachedPlugins(fixture, plugins);
      const referenceEffective = reference.filter((entry) =>
        pluginAppliesToProxy(entry, fixture),
      );
      const referenceInapplicable = reference.filter(
        (entry) => !pluginAppliesToProxy(entry, fixture),
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
      ids(reference.filter((entry) => pluginAppliesToProxy(entry, target))),
    );
    expect(ids(inapplicablePluginsForProxy(target, plugins))).toEqual(
      ids(reference.filter((entry) => !pluginAppliesToProxy(entry, target))),
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
      "global-key",
      "global-acl",
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

    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual(["global-key", "global-acl"]);
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

      // Equal priority and name: Edge's assembly order decides, globals,
      // then proxy-scoped, then proxy-group instances.
      expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([
        "global-limit",
        "scoped-limit",
        "group-limit",
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
      "global-acl",
      "global-key",
    ]);
    expect(analyzeProxyPolicy(shadowedProxy, plugins, [alice]).consumers[0]?.decision).toBe(
      "allowed",
    );
  });
});

describe("access_control without an identity source (#470)", () => {
  // Ferrum Edge v0.9.21 `src/plugins/access_control.rs` `authorize_identity`
  // rejects with 401 "No consumer identified" whenever neither a consumer nor
  // an authenticated identity was established, before any list is consulted.
  const bare = proxy({ id: "p", plugins: [] });
  const people = [
    consumer("1", "alice", ["operators"], { keyauth: [{ key: "[REDACTED]" }] }),
    consumer("2", "bob", [], {}),
  ];
  const adminOnly = { trigger: { when: { match: { path: { prefix: ["/admin"] } } } } };

  it.each([
    { label: "allow-list only", config: { allowed_consumers: ["alice"] } },
    { label: "group allow-list only", config: { allowed_groups: ["operators"] } },
    { label: "deny-list only", config: { disallowed_consumers: ["mallory"] } },
    { label: "group deny-list only", config: { disallowed_groups: ["suspended"] } },
    { label: "external-identity bypass only", config: { allow_authenticated_identity: true } },
  ])("denies every consumer for an untriggered $label ACL with no auth plugin", ({ config }) => {
    const analysis = analyzeProxyPolicy(bare, [
      plugin("acl", "access_control", "global", config),
      plugin("logging", "stdout_logging", "global"),
    ], people);

    expect(analysis.authPlugins).toEqual([]);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual(["denied", "denied"]);
    for (const entry of analysis.consumers) {
      expect(entry.reasons.join(" ")).toContain("acl rejects every request with 401");
    }
    expect(analysis.configurationProblems).toHaveLength(1);
    expect(analysis.configurationProblems[0]).toContain("no effective plugin establishes one");
    expect(analysis.conditional).toBe(false);
  });

  it("reproduces the reported global allow-list case as denied, not public", () => {
    const result = analyzeProxyPolicy(
      { ...bare, backend_scheme: "https" },
      [plugin("acl", "access_control", "global", { allowed_consumers: ["alice"] })],
      [consumer("alice-id", "alice", [], {})],
    ).consumers[0];
    expect(result?.decision).toBe("denied");
    expect(result?.reasons.join(" ")).not.toContain("No recognized effective authentication");
  });

  it("denies on a stream proxy whose only auth plugin is HTTP-only", () => {
    const streamProxy = proxy({
      backend_scheme: "tcp",
      listen_port: 18_443,
      listen_path: null,
      plugins: [],
    });
    const analysis = analyzeProxyPolicy(streamProxy, [
      plugin("global-jwt", "jwt_auth", "global"),
      plugin("acl", "access_control", "global", { allowed_consumers: ["alice"] }),
    ], people);
    expect(analysis.authPlugins).toEqual([]);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual(["denied", "denied"]);
    expect(analysis.configurationProblems).toHaveLength(1);
  });

  it("keeps a triggered ACL without auth conditional rather than public or denied", () => {
    const analysis = analyzeProxyPolicy(bare, [
      plugin("acl", "access_control", "global", { allowed_consumers: ["alice"] }, adminOnly),
    ], people);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual([
      "conditional",
      "conditional",
    ]);
    expect(analysis.consumers[0]?.reasons.join(" ")).toContain("401");
    expect(analysis.configurationProblems).toEqual([]);
    expect(analysis.conditional).toBe(true);
  });

  it("lets an untriggered ACL decide even beside a triggered one", () => {
    const analysis = analyzeProxyPolicy(bare, [
      plugin("acl-a", "access_control", "global", { allowed_consumers: ["alice"] }, adminOnly),
      plugin("acl-b", "access_control", "global", { disallowed_groups: ["suspended"] }),
    ], people);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual(["denied", "denied"]);
    expect(analysis.consumers[0]?.reasons).toEqual([
      expect.stringContaining("acl-b rejects every request with 401"),
    ]);
    expect(analysis.configurationProblems).toHaveLength(1);
  });

  it("treats an unrecognized plugin as an identity source it cannot model", () => {
    for (const plugins of [
      [
        plugin("acl", "access_control", "global", { allowed_consumers: ["alice"] }),
        plugin("custom", "acme_custom_auth", "global"),
      ],
      [plugin("custom", "acme_custom_auth", "global")],
    ]) {
      const analysis = analyzeProxyPolicy(bare, plugins, people);
      expect(analysis.consumers.map((entry) => entry.decision)).toEqual([
        "conditional",
        "conditional",
      ]);
      expect(analysis.consumers[0]?.reasons.join(" ")).toContain("acme_custom_auth");
      expect(analysis.configurationProblems).toEqual([]);
      expect(analysis.conditional).toBe(true);
    }
  });

  it("keeps a proxy with neither authentication nor ACL public", () => {
    const analysis = analyzeProxyPolicy(bare, [
      plugin("logging", "stdout_logging", "global"),
      plugin("rate", "rate_limiting", "global"),
    ], people);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual(["public", "public"]);
    expect(analysis.configurationProblems).toEqual([]);
    expect(analysis.conditional).toBe(false);
  });

  it("leaves ACL evaluation unchanged once an auth plugin establishes identity", () => {
    const analysis = analyzeProxyPolicy(bare, [
      plugin("key", "key_auth", "global"),
      plugin("acl", "access_control", "global", { allowed_consumers: ["alice"] }),
    ], people);
    expect(analysis.consumers.map((entry) => entry.decision)).toEqual(["allowed", "denied"]);
    expect(analysis.configurationProblems).toEqual([]);
  });
});

describe("chain order and authentication mode (Ferrum Edge v0.9.21)", () => {
  const keyed = consumer("1", "alice", [], { keyauth: [{ key: "[REDACTED]" }] });
  const jwtOnly = consumer("2", "bob", [], { jwt: [{ secret: "[REDACTED]" }] });
  const ids = (plugins: EffectivePlugin[]) => plugins.map((entry) => entry.id);

  it("orders by default priority, then plugin name, then Edge's assembly order", () => {
    const plugins = [
      plugin("a-logging", "stdout_logging", "global"),
      plugin("b-key", "key_auth", "global"),
      plugin("c-cors", "cors", "global"),
      plugin("d-rate", "rate_limiting", "proxy", {}, { proxy_id: "proxy-1" }),
      plugin("e-jwt", "jwt_auth", "proxy_group"),
      plugin("f-acl", "access_control", "global", { allowed_consumers: ["alice"] }, { priority_override: 1 }),
      // Same priority as cors: `correlation_id` sorts before `cors` bytewise.
      plugin("g-corr", "correlation_id", "global", {}, { priority_override: 100 }),
    ];
    const target = proxy({
      plugins: [{ plugin_config_id: "e-jwt" }, { plugin_config_id: "d-rate" }],
    });
    expect(ids(effectivePluginsForProxy(target, plugins))).toEqual([
      "f-acl", "g-corr", "c-cors", "e-jwt", "b-key", "d-rate", "a-logging",
    ]);
  });

  it("refuses every Consumer when the only allow-list is allowed_external_identities", () => {
    const plugins = [
      plugin("key", "key_auth", "global"),
      plugin("acl", "access_control", "global", {
        allowed_external_identities: [{ identity: "svc-a" }],
      }),
    ];
    const result = analyzeProxyPolicy(proxy({ plugins: [] }), plugins, [keyed]).consumers[0];
    expect(result?.decision).toBe("denied");
    expect(result?.reasons.join(" ")).toContain("allows only external identities");
  });

  it("settles a Consumer whose credential belongs to the first plugin in single mode", () => {
    const plugins = [plugin("jwt", "jwt_auth", "global"), plugin("key", "key_auth", "global")];
    // jwt_auth (1100) runs before key_auth (1200).
    const single = analyzeProxyPolicy(proxy({ plugins: [] }), plugins, [jwtOnly, keyed]);
    expect(single.consumers.map((entry) => entry.decision)).toEqual(["allowed", "conditional"]);
    expect(single.consumers[1]?.reasons.join(" ")).toContain("single auth mode");
    expect(single.consumers[1]?.reasons.join(" ")).toContain("jwt_auth, key_auth");
    expect(single.conditional).toBe(true);

    const multi = analyzeProxyPolicy(
      proxy({ plugins: [], auth_mode: "multi" }), plugins, [jwtOnly, keyed],
    );
    expect(multi.consumers.map((entry) => entry.decision)).toEqual(["allowed", "allowed"]);
    expect(multi.conditional).toBe(false);
  });

  it("runs every authentication hook on a stream proxy, whatever the auth mode", () => {
    const erin = consumer("5", "erin", [], { mtls_auth: [{ identity: "erin.example" }] });
    const stream = (auth_mode: Proxy["auth_mode"], attached: string[]) => proxy({
      id: "tcp-1",
      backend_scheme: "tcps",
      listen_port: 18_443,
      listen_path: null,
      auth_mode,
      plugins: attached.map((plugin_config_id) => ({ plugin_config_id })),
    });
    const plugins = [
      plugin("m1", "mtls_auth", "proxy", {}, { proxy_id: "tcp-1" }),
      plugin("m2", "mtls_auth", "proxy", { required_subject_ou: "payments" }, { proxy_id: "tcp-1" }),
    ];
    for (const mode of ["single", "multi"] as const) {
      // Two hooks: each must accept the certificate, which the stored
      // credential cannot show, so neither mode's HTTP short-circuit applies.
      const both = analyzeProxyPolicy(stream(mode, ["m1", "m2"]), plugins, [erin]);
      expect(both.consumers[0]?.decision, mode).toBe("conditional");
      expect(both.consumers[0]?.reasons.join(" ")).toContain("On a stream proxy");
      expect(both.conditional, mode).toBe(true);
      // One hook: the stored mTLS credential settles it.
      const one = analyzeProxyPolicy(stream(mode, ["m1"]), plugins, [erin]);
      expect(one.consumers[0]?.decision, mode).toBe("allowed");
    }
  });
});
