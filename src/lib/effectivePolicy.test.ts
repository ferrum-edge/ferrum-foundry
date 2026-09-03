import { describe, expect, it } from "vitest";
import type { Consumer, PluginConfig, Proxy } from "@/api/types";
import {
  analyzeProxyPolicy,
  effectivePluginsForProxy,
  inapplicablePluginsForProxy,
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

describe("effective authorization policy", () => {
  it("includes enabled global, direct, and associated group plugins", () => {
    const plugins = [
      plugin("global-auth", "key_auth", "global"),
      plugin("direct-auth", "jwt_auth", "proxy", {}, { proxy_id: "proxy-1" }),
      plugin("other-direct", "basic_auth", "proxy", {}, { proxy_id: "proxy-2" }),
      plugin("group-acl", "access_control", "proxy_group"),
      plugin("disabled", "hmac_auth", "global", {}, { enabled: false }),
    ];
    expect(effectivePluginsForProxy(proxy(), plugins).map((entry) => entry.id)).toEqual([
      "direct-auth",
      "global-auth",
      "group-acl",
    ]);
  });

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
});
