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
 * The pre-index implementation, kept here as the equivalence oracle: it filters
 * the whole collection for one proxy exactly as the route used to on every
 * iteration. The indexed path must return byte-for-byte the same plugins,
 * ordering, and sources.
 */
function referenceAttachedPlugins(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  const associated = new Set(
    (proxy.plugins ?? []).map((association) => association.plugin_config_id),
  );

  return pluginConfigs
    .filter((plugin) => {
      if (!plugin.enabled) return false;
      if (plugin.scope === "global") return true;
      if (plugin.scope === "proxy") {
        return plugin.proxy_id === proxy.id && associated.has(plugin.id);
      }
      return plugin.proxy_id == null && associated.has(plugin.id);
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

  it("resolves each proxy identically to a whole-collection scan on a mixed fixture", () => {
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
      p2: ["direct-p2", "global-auth", "global-cors", "global-logging", "group-rate"],
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
