/* ------------------------------------------------------------------ */
/*  Where Ferrum Edge refuses a masked placeholder (ferrum-edge#5925)  */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  pluginConfigPlaceholderSites,
  pluginConfigRefusedSites,
  pluginPlaceholderSites,
  pluginTriggerPlaceholderSites,
  proxyPlaceholderSites,
  refuseMaskedResourceWrite,
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

  it("does not block a URL-shaped placeholder the read shows verbatim", () => {
    const config = { docs_url: "https://docs.example.com/[REDACTED_PATH]" };
    expect(pluginConfigRefusedSites("ai_prompt_shield", config)).toEqual([]);
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", config, "operator")).toEqual({
      blocking: [],
      sources: [],
      reserved: [],
      other: ["/config/docs_url"],
    });
  });

  it("blocks the exact placeholder in any string, as Edge main refuses it (ferrum-edge#7054)", () => {
    const config = {
      redaction_placeholder: "[REDACTED]",
      docs_url: "https://docs.example.com/[REDACTED_PATH]",
    };
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", config, "operator")).toEqual({
      blocking: ["/config/redaction_placeholder"],
      sources: [],
      reserved: ["/config/redaction_placeholder"],
      other: ["/config/docs_url"],
    });
    // A certificate-plus-key bundle Edge main masks in `mtls_auth` reads as
    // `[REDACTED]`, which the pinned table has no rule for: still blocked.
    expect(
      pluginConfigRefusedSites("mtls_auth", {
        allowed_issuers: [{ ca_certificate_pem: "[REDACTED]" }],
      }),
    ).toEqual(["/config/allowed_issuers/0/ca_certificate_pem"]);
  });

  it("tells a masked secret from a TLS source and a reserved literal", () => {
    // `mesh_route_dispatch` has a secret rule and a route-local TLS key slot
    // the TLS-material layer classifies by name.
    const sites = pluginConfigPlaceholderSites(
      "mesh_route_dispatch",
      {
        rules: [
          {
            request_transform: [{ operation: "set", value: "[REDACTED]" }],
            destination: { backend_tls: { client_key_path: "[REDACTED]" } },
            note: "[REDACTED]",
          },
        ],
      },
      "operator",
    );
    expect(sites.blocking).toEqual([
      "/config/rules/0/request_transform/0/value",
      "/config/rules/0/destination/backend_tls/client_key_path",
      "/config/rules/0/note",
    ]);
    expect(sites.sources).toEqual(["/config/rules/0/destination/backend_tls/client_key_path"]);
    expect(sites.reserved).toEqual(["/config/rules/0/note"]);
  });

  it("follows Kafka's safe list and a scalar where a container was expected", () => {
    // A URL-shaped placeholder is a site only where a layer masks the field:
    // `client.id` is on the safe list, `ssl.key.location` is not.
    const masked = "https://kafka.example.com/[REDACTED_PATH]";
    expect(
      pluginConfigRefusedSites("kafka_logging", {
        producer_config: { "client.id": masked, "ssl.key.location": masked },
      }),
    ).toEqual(["/config/producer_config/ssl.key.location"]);
    // The exact placeholder is refused even on the safe list (ferrum-edge#7054).
    expect(
      pluginConfigRefusedSites("kafka_logging", {
        producer_config: { acks: "[REDACTED]", "ssl.key.location": "[REDACTED]" },
      }),
    ).toEqual([
      "/config/producer_config/ssl.key.location",
      "/config/producer_config/acks",
    ]);
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
      sources: [],
      reserved: [],
      other: ["/config/credentials/x"],
    });
    // The same key holding the placeholder itself is the site, and is refused.
    const whole = { credentials: "[REDACTED]" };
    expect(pluginConfigPlaceholderSites("ai_prompt_shield", whole, "operator")).toEqual({
      blocking: ["/config/credentials"],
      sources: [],
      reserved: [],
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
      sources: [],
      reserved: [],
      other: ["/config/endpoint_url"],
    });
    expect(
      upstreamPlaceholderSites(
        { service_discovery: { consul: { token: "[REDACTED]" } } },
        "admin",
      ),
    ).toEqual({
      blocking: [],
      sources: [],
      reserved: [],
      other: ["/service_discovery/consul/token"],
    });
    expect(proxyPlaceholderSites({ backend_tls_client_key_path: "[REDACTED]" }, "admin")).toEqual({
      blocking: [],
      sources: [],
      reserved: [],
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

describe("plugin trigger placeholders (Edge main masks header, query and cookie operands)", () => {
  const masked = {
    when: {
      any: [
        { not: { match: { header: { name: "x-skip-waf", value: { exact: ["[REDACTED]", "[REDACTED]"] } } } } },
        { match: { query: { name: "debug", value: { regex: "[REDACTED]" } } } },
        { match: { cookie: { name: "canary", value: { prefix: ["[REDACTED]"] } } } },
        { match: { path: { exact: ["[REDACTED]"] } } },
      ],
    },
  };
  const operandSites = [
    "/trigger/when/any/0/not/match/header/value/exact/0",
    "/trigger/when/any/0/not/match/header/value/exact/1",
    "/trigger/when/any/1/match/query/value/regex",
    "/trigger/when/any/2/match/cookie/value/prefix/0",
  ];

  it("blocks a placeholder at each operand for a non-admin or unknown role", () => {
    for (const role of ["operator", "viewer", null, undefined] as const) {
      expect(pluginTriggerPlaceholderSites(masked, role)).toEqual({
        blocking: operandSites,
        sources: [],
        reserved: [],
        // A visible predicate is shown as stored, so it is only a warning.
        other: ["/trigger/when/any/3/match/path/exact/0"],
      });
    }
  });

  it("blocks nothing for an admin, whose reads are raw", () => {
    expect(pluginTriggerPlaceholderSites(masked, "admin")).toEqual({
      blocking: [],
      sources: [],
      reserved: [],
      other: [...operandSites, "/trigger/when/any/3/match/path/exact/0"],
    });
  });

  it("blocks a placeholder anywhere inside a malformed trigger shape", () => {
    expect(
      pluginTriggerPlaceholderSites(
        { when: { match: { header: { name: "x", value: { exact: [{ nested: "[REDACTED]" }] } } } } },
        "operator",
      ).blocking,
    ).toEqual(["/trigger/when/match/header/value/exact/0/nested"]);
    expect(pluginTriggerPlaceholderSites({ if: ["[REDACTED]"] }, "operator").blocking).toEqual([
      "/trigger/if/0",
    ]);
    // Ill-typed content under a visible key is withheld, so a placeholder in
    // it blocks rather than only warning.
    expect(
      pluginTriggerPlaceholderSites(
        { when: { match: { header: { name: { pasted: "[REDACTED]" } } } } },
        "operator",
      ),
    ).toEqual({
      blocking: ["/trigger/when/match/header/name/pasted"],
      sources: [],
      reserved: [],
      other: [],
    });
    expect(
      pluginTriggerPlaceholderSites({ when: { match: { path: { exact: [["[REDACTED]"]] } } } }, "operator")
        .blocking,
    ).toEqual(["/trigger/when/match/path/exact/0/0"]);
    // A well-typed visible value is shown as stored: a warning only.
    expect(
      pluginTriggerPlaceholderSites({ when: { match: { header: { name: "[REDACTED]" } } } }, "operator"),
    ).toEqual({
      blocking: [],
      sources: [],
      reserved: [],
      other: ["/trigger/when/match/header/name"],
    });
    expect(pluginTriggerPlaceholderSites("[REDACTED]", "operator").blocking).toEqual(["/trigger"]);
    expect(pluginTriggerPlaceholderSites(null, "operator").blocking).toEqual([]);
    expect(pluginTriggerPlaceholderSites(undefined, "operator").blocking).toEqual([]);
  });

  it("names config and trigger sites together for a write that resends a plugin read", () => {
    const sites = pluginPlaceholderSites(
      {
        plugin_name: "http_logging",
        config: { custom_headers: { "x-api-key": "[REDACTED]" } },
        trigger: masked,
      },
      "operator",
    );
    expect(sites.blocking).toEqual(["/config/custom_headers/x-api-key", ...operandSites]);
    expect(sites.other).toEqual(["/trigger/when/any/3/match/path/exact/0"]);
    expect(
      pluginPlaceholderSites({ plugin_name: "http_logging", config: {}, trigger: masked }, "admin")
        .blocking,
    ).toEqual([]);
  });
});
