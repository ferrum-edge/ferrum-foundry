/* ------------------------------------------------------------------ */
/*  Where Ferrum Edge refuses a masked placeholder (ferrum-edge#5925)  */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  pluginConfigPlaceholderSites,
  pluginConfigRefusedSites,
  proxyPlaceholderSites,
  refuseMaskedResourceWrite,
  refuseMaskedUpstreamSettingsWrite,
  upstreamPlaceholderSites,
} from "./maskedSecretSites";
import { MaskedSecretWriteError } from "./maskedSecrets";

describe("plugin config sites Edge refuses for a non-admin role", () => {
  it("blocks the schema's endpoint and header sites", () => {
    expect(
      pluginConfigRefusedSites("http_logging", {
        endpoint_url: "https://collector.example.com/[REDACTED_PATH]?[REDACTED_QUERY]",
        custom_headers: { "x-honeycomb-team": "[REDACTED]" },
        batch_size: 50,
      }),
    ).toEqual(["/config/endpoint_url", "/config/custom_headers/x-honeycomb-team"]);
  });

  it("blocks the name floor, the Redis URL rule, and the URL-userinfo sweep", () => {
    expect(
      pluginConfigRefusedSites("ai_prompt_shield", {
        upstream_password: "[REDACTED]",
        nested: [{ redisUrl: "redis://redacted@cache.internal:6379/3" }],
        callback_url: "https://redacted@hooks.example.com/notify",
      }),
    ).toEqual([
      "/config/upstream_password",
      "/config/nested/0/redisUrl",
      "/config/callback_url",
    ]);
  });

  it("does not block a placeholder-shaped value the read shows verbatim", () => {
    const config = {
      redaction_placeholder: "[REDACTED]",
      docs_url: "https://docs.example.com/[REDACTED_PATH]",
    };
    expect(pluginConfigRefusedSites("ai_prompt_shield", config)).toEqual([]);
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", config, "operator")).toEqual({
      blocking: [],
      other: ["/config/redaction_placeholder", "/config/docs_url"],
    });
  });

  it("follows Kafka's safe list and a scalar where a container was expected", () => {
    expect(
      pluginConfigRefusedSites("kafka_logging", {
        producer_config: { acks: "[REDACTED]", "ssl.key.location": "[REDACTED]" },
      }),
    ).toEqual(["/config/producer_config/ssl.key.location"]);
    expect(pluginConfigRefusedSites("opa", { headers: "[REDACTED]" })).toEqual([
      "/config/headers",
    ]);
  });

  it("treats a container withheld wholesale as one site, not its contents", () => {
    // Edge withholds a name-floor key's object whole: the object is the site,
    // and it is not a placeholder, so nothing inside it is refused.
    const nested = { credentials: { x: "[REDACTED]" } };
    expect(pluginConfigRefusedSites("ai_prompt_shield", nested)).toEqual([]);
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", nested, "operator")).toEqual({
      blocking: [],
      other: ["/config/credentials/x"],
    });
    // The same key holding the placeholder itself is the site, and is refused.
    const whole = { credentials: "[REDACTED]" };
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", whole, "operator")).toEqual({
      blocking: ["/config/credentials"],
      other: [],
    });
  });

  it("treats a config that is not an object as one withheld site", () => {
    expect(pluginConfigRefusedSites("http_logging", "[REDACTED]")).toEqual(["/config"]);
    expect(pluginConfigRefusedSites("http_logging", null)).toEqual([]);
  });

  it("blocks every placeholder of a plugin Foundry has no rules for", () => {
    const config = { redaction_placeholder: "[REDACTED]", note: "visible" };
    expect(pluginConfigRefusedSites("custom_plugin", config)).toEqual([
      "/config/redaction_placeholder",
    ]);
    expect(pluginConfigPlaceholderSites("custom_plugin", config, "operator").blocking).toEqual([
      "/config/redaction_placeholder",
    ]);
  });
});

describe("role", () => {
  const config = {
    endpoint_url: "https://collector.example.com/[REDACTED_PATH]",
    batch_size: 50,
  };

  it("never blocks an admin, whose reads are raw", () => {
    expect(pluginConfigPlaceholderSites("http_logging", config, "admin")).toEqual({
      blocking: [],
      other: ["/config/endpoint_url"],
    });
    expect(
      upstreamPlaceholderSites(
        { service_discovery: { consul: { token: "[REDACTED]" } } },
        "admin",
      ),
    ).toEqual({ blocking: [], other: ["/service_discovery/consul/token"] });
    expect(proxyPlaceholderSites({ backend_tls_client_key_path: "[REDACTED]" }, "admin")).toEqual({
      blocking: [],
      other: ["/backend_tls_client_key_path"],
    });
  });

  it.each(["operator", null, undefined] as const)("blocks for %s", (role) => {
    expect(pluginConfigPlaceholderSites("http_logging", config, role).blocking).toEqual([
      "/config/endpoint_url",
    ]);
    expect(
      upstreamPlaceholderSites({ service_discovery: { consul: { token: "[REDACTED]" } } }, role)
        .blocking,
    ).toEqual(["/service_discovery/consul/token"]);
    expect(
      upstreamPlaceholderSites({ backend_tls_client_key_path: "[REDACTED]" }, role).blocking,
    ).toEqual(["/backend_tls_client_key_path"]);
    expect(
      proxyPlaceholderSites({ backend_tls_client_key_path: "[REDACTED]" }, role).blocking,
    ).toEqual(["/backend_tls_client_key_path"]);
  });
});

describe("a proxy or upstream write refused before it is sent (ferrum-edge#7060)", () => {
  // A subset TLS key the upstream editor does not show, round-tripped from the read.
  const upstream = {
    name: "payments",
    subsets: [{ name: "v2", traffic_policy: { tls: { private_key: "[REDACTED]" } } }],
  };

  it("refuses a non-admin write naming each masked site and no value", () => {
    for (const role of ["operator", null, undefined] as const) {
      let refused: unknown;
      try {
        refuseMaskedResourceWrite("Upstream", "payments", upstream, role);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(MaskedSecretWriteError);
      expect((refused as MaskedSecretWriteError).pointers).toEqual([
        "/subsets/0/traffic_policy/tls/private_key",
      ]);
    }
    expect(() =>
      refuseMaskedResourceWrite("Proxy", "orders", { backend_tls_client_key_path: "[REDACTED]" }, "operator"),
    ).toThrow(MaskedSecretWriteError);
  });

  it("lets an admin's write and a write without a placeholder through", () => {
    expect(() => refuseMaskedResourceWrite("Upstream", "payments", upstream, "admin")).not.toThrow();
    expect(() =>
      refuseMaskedResourceWrite("Proxy", "orders", { backend_tls_client_key_path: "/k.pem" }, "operator"),
    ).not.toThrow();
  });
});

describe("an upstream settings save checks the subsets of the read it was seeded from", () => {
  const seed = {
    name: "payments",
    subsets: [{ name: "v2", labels: {}, traffic_policy: { tls: { private_key: "[REDACTED]" } } }],
    port_overrides: { "8443": { tls: { client_key_path: "[REDACTED]" } } },
  };
  // A save that removed subset v2 (and renamed its replacement), so the masked
  // key is only in the seed; port_overrides is never sent.
  const payload = { name: "renamed", subsets: [{ name: "v3", labels: {} }] };

  const refusal = (role: "admin" | "operator" | null) => {
    try {
      refuseMaskedUpstreamSettingsWrite("payments", seed, payload, role);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("refuses a non-admin save that would silently drop a masked subset key", () => {
    for (const role of ["operator", null] as const) {
      const error = refusal(role);
      expect(error).toBeInstanceOf(MaskedSecretWriteError);
      expect((error as MaskedSecretWriteError).pointers).toEqual([
        "/subsets/0/traffic_policy/tls/private_key",
      ]);
    }
  });

  it("lets an admin save, and checks the payload as well", () => {
    expect(refusal("admin")).toBeUndefined();
    expect(() =>
      refuseMaskedUpstreamSettingsWrite(
        "payments",
        { name: "payments" },
        { backend_tls_client_key_path: "[REDACTED]" },
        "operator",
      ),
    ).toThrow(MaskedSecretWriteError);
    expect(() =>
      refuseMaskedUpstreamSettingsWrite("payments", { name: "payments" }, payload, "operator"),
    ).not.toThrow();
  });
});
