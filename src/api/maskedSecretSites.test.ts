/* ------------------------------------------------------------------ */
/*  Where Ferrum Edge refuses a masked placeholder (ferrum-edge#5925)  */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  pluginConfigPlaceholderSites,
  pluginConfigRefusedSites,
  upstreamPlaceholderSites,
} from "./maskedSecretSites";

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
  });

  it.each(["operator", null, undefined] as const)("blocks for %s", (role) => {
    expect(pluginConfigPlaceholderSites("http_logging", config, role).blocking).toEqual([
      "/config/endpoint_url",
    ]);
    expect(
      upstreamPlaceholderSites({ service_discovery: { consul: { token: "[REDACTED]" } } }, role)
        .blocking,
    ).toEqual(["/service_discovery/consul/token"]);
  });
});
