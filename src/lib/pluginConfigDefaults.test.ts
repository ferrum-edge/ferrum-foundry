import { describe, expect, it } from "vitest";
import {
  PLUGIN_METADATA,
  formatPluginName,
  getPluginConfigDefault,
} from "./pluginConfigDefaults";

describe("canonical plugin defaults", () => {
  it("uses the closed correlation_id shape", () => {
    expect(getPluginConfigDefault("correlation_id")).toEqual({
      header_name: "X-Correlation-ID",
      echo_downstream: true,
    });
  });

  it("places rate windows inside the required limits rules", () => {
    expect(getPluginConfigDefault("rate_limiting")).toEqual({
      limit_by: "consumer",
      expose_headers: true,
      limits: [{
        scope: "default",
        requests_per_second: 400,
        requests_per_minute: 20000,
      }],
      sync_mode: "local",
    });
  });
});

describe("formatPluginName", () => {
  it.each([
    ["cors", "CORS"],
    ["waf", "WAF"],
    ["a2a_gateway", "A2A Gateway"],
    ["jwks_auth", "JWKS Auth"],
    ["jwt_auth", "JWT Auth"],
    ["mtls_auth", "mTLS Auth"],
    ["hmac_auth", "HMAC Auth"],
    ["ldap_auth", "LDAP Auth"],
    ["oauth2_introspection", "OAuth2 Introspection"],
    ["oidc_relying_party", "OIDC Relying Party"],
    ["opa", "OPA"],
    ["otel_tracing", "OpenTelemetry Tracing"],
    ["grpc_web", "gRPC-Web"],
    ["grpc_method_router", "gRPC Method Router"],
    ["grpc_deadline", "gRPC Deadline"],
    ["graphql", "GraphQL"],
    ["mcp_gateway", "MCP Gateway"],
    ["sse", "SSE"],
    ["ai_prompt_shield", "AI Prompt Shield"],
    ["ai_rate_limiter", "AI Rate Limiter"],
    ["soap_ws_security", "SOAP WS-Security"],
    ["ip_restriction", "IP Restriction"],
    ["geo_restriction", "Geo Restriction"],
    ["spiffe_identity", "SPIFFE Identity"],
    ["udp_rate_limiting", "UDP Rate Limiting"],
    ["tcp_connection_throttle", "TCP Connection Throttle"],
    ["tcp_logging", "TCP Logging"],
    ["udp_logging", "UDP Logging"],
    ["ws_logging", "WebSocket Logging"],
    ["ws_rate_limiting", "WebSocket Rate Limiting"],
    ["ws_message_size_limiting", "WebSocket Message Size Limiting"],
    ["ws_frame_logging", "WebSocket Frame Logging"],
    ["http_logging", "HTTP Logging"],
    ["statsd_logging", "StatsD Logging"],
    ["api_chargeback_sink", "API Chargeback Sink"],
    ["openapi_validator", "OpenAPI Validator"],
    ["dns_sd", "DNS SD"],
  ])("renders the non-derivable name %s as %s", (key, expected) => {
    expect(formatPluginName(key)).toBe(expected);
  });

  it("title-cases derivable names", () => {
    expect(formatPluginName("access_control")).toBe("Access Control");
    expect(formatPluginName("request_transformer")).toBe("Request Transformer");
    expect(formatPluginName("correlation_id")).toBe("Correlation ID");
    expect(formatPluginName("api_chargeback")).toBe("API Chargeback");
  });

  it("upper-cases acronyms in names it has never seen", () => {
    expect(formatPluginName("some_new_tls_thing")).toBe("Some New TLS Thing");
    expect(formatPluginName("future_ip_acl")).toBe("Future IP ACL");
    expect(formatPluginName("saml_xml_signer")).toBe("SAML XML Signer");
  });

  it("shows gateway-reserved internal plugins verbatim", () => {
    expect(formatPluginName("__ferrum_internal")).toBe("__ferrum_internal");
  });

  it("tolerates blank input", () => {
    expect(formatPluginName("")).toBe("");
    expect(formatPluginName("   ")).toBe("");
  });

  it("gives every catalog plugin a distinct, readable display name", () => {
    // The title-cased form of a token the formatter is supposed to know as an
    // acronym ("Tls", "Ai", "Grpc", ...) means the catalog reads wrong.
    const mangledAcronym =
      /^(?:A2a|Acl|Ai|Api|Cors|Crl|Dns|Dtls|Grpc|Hmac|Http|Https|Id|Ip|Jwks|Jwt|Ldap|Mcp|Mtls|Oidc|Opa|Otel|Saml|Sni|Soap|Spiffe|Sse|Ssl|Tcp|Tls|Udp|Url|Waf|Ws|Xml)$/;
    const seen = new Map<string, string>();

    for (const key of Object.keys(PLUGIN_METADATA)) {
      const display = formatPluginName(key);
      expect(display, key).not.toBe("");
      expect(display, key).not.toContain("_");
      for (const word of display.split(/[\s-]+/)) {
        expect(word, `${key} -> ${display}`).not.toMatch(mangledAcronym);
      }
      expect(seen.get(display), `${key} collides with ${seen.get(display)}`).toBeUndefined();
      seen.set(display, key);
    }
  });
});
