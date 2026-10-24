import { describe, expect, it } from "vitest";
import type { BackendScheme } from "@/api/types";
import {
  STREAM_PLUGIN_MATRIX_SOURCE,
  isStreamProxy,
  pluginAppliesToProxy,
} from "./pluginProtocols";

function proxy(backend_scheme?: BackendScheme) {
  return { backend_scheme };
}

function named(plugin_name: string, config: Record<string, unknown> = {}) {
  return { plugin_name, config };
}

describe("stream proxy detection", () => {
  it("treats tcp, tcps, udp, and dtls as stream schemes", () => {
    for (const scheme of ["tcp", "tcps", "udp", "dtls"] as const) {
      expect(isStreamProxy(proxy(scheme)), scheme).toBe(true);
    }
  });

  it("treats http, https, and an absent scheme as HTTP", () => {
    expect(isStreamProxy(proxy("http"))).toBe(false);
    expect(isStreamProxy(proxy("https"))).toBe(false);
    expect(isStreamProxy(proxy())).toBe(false);
  });

  it("documents where the matrix comes from", () => {
    expect(STREAM_PLUGIN_MATRIX_SOURCE).toContain("docs/tcp_udp_proxy.md");
    expect(STREAM_PLUGIN_MATRIX_SOURCE).toContain("docs/plugin_execution_order.md");
  });
});

describe("plugin applicability", () => {
  it("applies every plugin on an HTTP proxy", () => {
    for (const name of [
      "cors",
      "jwt_auth",
      "request_transformer",
      "stdout_logging",
      "tcp_connection_throttle",
      "udp_rate_limiting",
      "some_future_plugin",
    ]) {
      expect(pluginAppliesToProxy(named(name), proxy("https")), name).toBe(true);
    }
  });

  it("skips HTTP-only plugins on a tcp proxy", () => {
    for (const name of ["cors", "jwt_auth", "request_transformer", "compression"]) {
      expect(pluginAppliesToProxy(named(name), proxy("tcp")), name).toBe(false);
    }
  });

  it("runs stream-capable plugins on a tcp proxy", () => {
    for (const name of [
      "stdout_logging",
      "rate_limiting",
      "tcp_connection_throttle",
      "ip_restriction",
      "mtls_auth",
      "access_control",
      "prometheus_metrics",
    ]) {
      expect(pluginAppliesToProxy(named(name), proxy("tcp")), name).toBe(true);
    }
    expect(pluginAppliesToProxy(named("tcp_connection_throttle"), proxy("tcps"))).toBe(true);
  });

  it("restricts the connection throttle to TCP and the datagram limiter to UDP", () => {
    expect(pluginAppliesToProxy(named("tcp_connection_throttle"), proxy("udp"))).toBe(false);
    expect(pluginAppliesToProxy(named("tcp_connection_throttle"), proxy("dtls"))).toBe(false);
    expect(pluginAppliesToProxy(named("udp_rate_limiting"), proxy("udp"))).toBe(true);
    expect(pluginAppliesToProxy(named("udp_rate_limiting"), proxy("dtls"))).toBe(true);
    expect(pluginAppliesToProxy(named("udp_rate_limiting"), proxy("tcp"))).toBe(false);
    expect(pluginAppliesToProxy(named("udp_rate_limiting"), proxy("tcps"))).toBe(false);
  });

  it("treats an unknown plugin name as HTTP-only on a stream proxy", () => {
    for (const scheme of ["tcp", "tcps", "udp", "dtls"] as const) {
      expect(pluginAppliesToProxy(named("some_future_plugin"), proxy(scheme)), scheme).toBe(
        false,
      );
    }
  });
});

describe("Edge v0.9.15 stream declarations (#636)", () => {
  it.each(["fault_injection", "api_chargeback", "proxy_alerts"])(
    "runs %s on every stream scheme",
    (name) => {
      for (const scheme of ["tcp", "tcps", "udp", "dtls"] as const) {
        expect(pluginAppliesToProxy(named(name), proxy(scheme)), scheme).toBe(true);
      }
    },
  );

  const signature = (action?: string) => ({ id: "sig-1", pattern: "^EVIL", ...(action ? { action } : {}) });

  it.each<[string, Record<string, unknown>]>([
    ["signatures", { stream: { signatures: [signature()] } }],
    ["monitor-mode signatures", { mode: "monitor", stream: { signatures: [signature("monitor")] } }],
    ["the TLS-shape guard alone", { stream: { tcp_require_tls: true } }],
    ["one enabled signature among disabled ones", {
      stream: { signatures: [signature("disabled"), signature("block")] },
    }],
  ])("runs waf on stream proxies with %s", (_label, config) => {
    for (const scheme of ["tcp", "tcps", "udp", "dtls"] as const) {
      expect(pluginAppliesToProxy(named("waf", config), proxy(scheme)), scheme).toBe(true);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ["no stream block", { mode: "enforce" }],
    ["a null stream block", { stream: null }],
    ["an empty stream block", { stream: {} }],
    ["only disabled signatures", {
      stream: { signatures: [signature("disabled"), signature("off"), signature("disable")] },
    }],
    ["tcp_require_tls off and no signatures", { stream: { tcp_require_tls: false, signatures: [] } }],
    ["the plugin disabled by mode", { mode: "disabled", stream: { tcp_require_tls: true, signatures: [signature()] } }],
  ])("skips waf on stream proxies with %s", (_label, config) => {
    for (const scheme of ["tcp", "tcps", "udp", "dtls"] as const) {
      expect(pluginAppliesToProxy(named("waf", config), proxy(scheme)), scheme).toBe(false);
    }
    expect(pluginAppliesToProxy(named("waf", config), proxy("https"))).toBe(true);
  });
});
