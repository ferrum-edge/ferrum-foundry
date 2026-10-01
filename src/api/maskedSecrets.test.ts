/* ------------------------------------------------------------------ */
/*  Masked-secret placeholders (ferrum-edge#5925)                      */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  isRedactionPlaceholder,
  maskedPlaceholderRefusal,
  MaskedSecretWriteError,
  parseMaskedPlaceholderMessage,
  pluginConfigPlaceholderPointers,
  removeAtPointer,
  upstreamPlaceholderPointers,
} from "./maskedSecrets";
import { RedactedWriteError } from "./secretRedaction";

// Edge's `masked_placeholder_message`, as its admin API guide shows it.
const EDGE_REFUSAL =
  "Upstream field(s) /service_discovery/consul/token carry the redaction placeholder that " +
  "'operator' reads return in place of the stored secret; writing it back would replace the " +
  "secret with the placeholder. Send the real value, or remove the field only if you mean to " +
  "clear it (PUT is a full replace and does not keep the stored value), or have an admin make " +
  "the change";

describe("isRedactionPlaceholder mirrors Edge's is_redaction_placeholder", () => {
  it.each([
    ["the wholesale marker", "[REDACTED]"],
    ["redacted userinfo with no password", "redis://redacted@cache.internal:6379/3"],
    ["redacted userinfo on an https endpoint", "https://redacted@collector.example.com"],
    ["an empty password, which a URL does not serialize", "redis://redacted:@cache.internal:6379"],
    ["the whole path", "https://collector.example.com/[REDACTED_PATH]"],
    ["the whole query", "redis://cache.internal:6379/3?[REDACTED_QUERY]"],
    ["the whole fragment", "redis://cache.internal:6379/3#[REDACTED_FRAGMENT]"],
    [
      "every component at once",
      "https://redacted@collector.example.com:8443/[REDACTED_PATH]?[REDACTED_QUERY]#[REDACTED_FRAGMENT]",
    ],
  ])("matches %s", (_label, value) => {
    expect(isRedactionPlaceholder(value)).toBe(true);
  });

  it.each([
    ["a real URL with redacted as a path segment", "https://collector.example.com/redacted/ingest"],
    ["a path that only contains the marker", "https://collector.example.com/v1/[REDACTED_PATH]"],
    ["a path with the marker and a suffix", "https://collector.example.com/[REDACTED_PATH]/x"],
    ["a query that only contains the marker", "https://collector.example.com/?a=[REDACTED_QUERY]"],
    ["a fragment that only contains the marker", "https://collector.example.com/#x[REDACTED_FRAGMENT]"],
    ["redacted userinfo with a password", "redis://redacted:secret@cache.internal:6379"],
    ["another username", "redis://redacted2@cache.internal:6379"],
    ["redacted as the host", "https://redacted/ingest"],
    ["the marker inside a longer string", "token [REDACTED]"],
    ["the marker with surrounding space", " [REDACTED]"],
    ["a differently cased marker", "[redacted]"],
    ["the bare path marker, which is not a URL", "[REDACTED_PATH]"],
    ["an ordinary secret", "s3cr3t-token"],
    ["an empty string", ""],
  ])("does not match %s", (_label, value) => {
    expect(isRedactionPlaceholder(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [true], [["[REDACTED]"]], [{ value: "[REDACTED]" }]])(
    "only ever matches a string (%j)",
    (value) => {
      expect(isRedactionPlaceholder(value)).toBe(false);
    },
  );
});

describe("placeholder sites", () => {
  it("names every plugin config site by JSON pointer under /config", () => {
    expect(
      pluginConfigPlaceholderPointers({
        endpoint_url: "https://collector.example.com/[REDACTED_PATH]?[REDACTED_QUERY]",
        custom_headers: { "x-honeycomb-team": "[REDACTED]", "x/odd~key": "[REDACTED]" },
        providers: [{ jwks_uri: "https://idp.example.com/keys" }, { jwks_uri: "[REDACTED]" }],
        batch_size: 50,
        note: "redacted",
      }),
    ).toEqual([
      "/config/endpoint_url",
      "/config/custom_headers/x-honeycomb-team",
      "/config/custom_headers/x~1odd~0key",
      "/config/providers/1/jwks_uri",
    ]);
    expect(pluginConfigPlaceholderPointers({ batch_size: 50 })).toEqual([]);
    expect(pluginConfigPlaceholderPointers("[REDACTED]")).toEqual(["/config"]);
  });

  it("checks only the Consul token on an upstream, the one site an operator read masks", () => {
    expect(
      upstreamPlaceholderPointers({
        service_discovery: { consul: { token: "[REDACTED]" } },
      }),
    ).toEqual(["/service_discovery/consul/token"]);
    expect(
      upstreamPlaceholderPointers({ service_discovery: { consul: { token: "real-acl-token" } } }),
    ).toEqual([]);
    expect(upstreamPlaceholderPointers({ service_discovery: { consul: { token: null } } })).toEqual(
      [],
    );
    expect(upstreamPlaceholderPointers({ service_discovery: null })).toEqual([]);
    expect(upstreamPlaceholderPointers({})).toEqual([]);
  });

  it("removes the member a pointer names without touching the original", () => {
    const config = {
      custom_headers: { "x-team": "[REDACTED]", "x/odd": "[REDACTED]", keep: "visible" },
      providers: [{ jwks_uri: "[REDACTED]" }, { jwks_uri: "https://idp.example.com/keys" }],
    };
    const snapshot = structuredClone(config);
    expect(removeAtPointer(config, "/custom_headers/x-team")).toEqual({
      ...config,
      custom_headers: { "x/odd": "[REDACTED]", keep: "visible" },
    });
    expect(removeAtPointer(config, "/custom_headers/x~1odd")).toEqual({
      ...config,
      custom_headers: { "x-team": "[REDACTED]", keep: "visible" },
    });
    expect(removeAtPointer(config, "/providers/0/jwks_uri")).toEqual({
      ...config,
      providers: [{}, { jwks_uri: "https://idp.example.com/keys" }],
    });
    expect(removeAtPointer(config, "/providers/0")).toEqual({
      ...config,
      providers: [{ jwks_uri: "https://idp.example.com/keys" }],
    });
    expect(removeAtPointer(config, "/missing/path")).toEqual(config);
    expect(removeAtPointer(config, "/providers/7")).toEqual(config);
    expect(removeAtPointer(config, "")).toBeUndefined();
    expect(config).toEqual(snapshot);
  });
});

describe("masked-placeholder refusals", () => {
  it("parses Edge's 400 message into its pointers and role", () => {
    expect(parseMaskedPlaceholderMessage(EDGE_REFUSAL)).toEqual({
      pointers: ["/service_discovery/consul/token"],
      role: "operator",
      local: false,
    });
    expect(
      parseMaskedPlaceholderMessage(
        "Plugin config field(s) /config/endpoint_url, /config/custom_headers/x-team, …and 3 more " +
          "carry the redaction placeholder that 'operator' reads return in place of the stored secret",
      )?.pointers,
    ).toEqual(["/config/endpoint_url", "/config/custom_headers/x-team", "…and 3 more"]);
    expect(parseMaskedPlaceholderMessage("Invalid body: missing field `targets`")).toBeNull();
  });

  it("finds Edge's refusal on a redacted write failure, through a wrapping cause", () => {
    const failure = new RedactedWriteError(
      "Request failed with status code 400 Bad Request",
      new Response(null, { status: 400 }),
      { error: EDGE_REFUSAL },
      "HTTPError",
    );
    expect(maskedPlaceholderRefusal(failure)?.pointers).toEqual([
      "/service_discovery/consul/token",
    ]);
    const wrapped = new Error("Plugin update did not converge", { cause: failure });
    expect(maskedPlaceholderRefusal(wrapped)?.role).toBe("operator");
  });

  it("ignores the same text on any status other than 400", () => {
    const failure = new RedactedWriteError(
      "Request failed with status code 409 Conflict",
      new Response(null, { status: 409 }),
      { error: EDGE_REFUSAL },
      "HTTPError",
    );
    expect(maskedPlaceholderRefusal(failure)).toBeNull();
    expect(maskedPlaceholderRefusal(new Error(EDGE_REFUSAL))).toBeNull();
    expect(maskedPlaceholderRefusal("not an error")).toBeNull();
  });

  it("reports Foundry's own refusal as local", () => {
    const refusal = maskedPlaceholderRefusal(
      new MaskedSecretWriteError("not sent", ["/service_discovery/consul/token"]),
    );
    expect(refusal).toEqual({
      pointers: ["/service_discovery/consul/token"],
      role: null,
      local: true,
    });
  });
});
