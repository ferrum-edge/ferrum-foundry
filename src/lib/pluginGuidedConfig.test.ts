import { describe, expect, it } from "vitest";
import {
  readGuidedConfig,
  unmodelledEnumSpelling,
  validateGuidedConfig,
  writeGuidedConfig,
  type GuidedValues,
  type JsonObject,
} from "./pluginGuidedConfig";
import { getGuidedSchema, GUIDED_PLUGINS } from "./pluginSchemas";
import { getPluginConfigDefault } from "./pluginConfigDefaults";

const keyAuth = getGuidedSchema("key_auth")!;
const rateLimiting = getGuidedSchema("rate_limiting")!;
const cors = getGuidedSchema("cors")!;

function roundTrip(schema: typeof keyAuth, config: JsonObject): JsonObject {
  const values = readGuidedConfig(schema, config);
  return writeGuidedConfig(schema, config, values, values);
}

describe("losslessness", () => {
  it("returns an untouched configuration byte-identically", () => {
    const config: JsonObject = {
      key_location: "header:X-Custom-Key",
      hide_credentials: false,
    };
    expect(JSON.stringify(roundTrip(keyAuth, config))).toBe(JSON.stringify(config));
  });

  it("preserves fields the descriptors do not model", () => {
    // A newer gateway field, or one this reduction deliberately leaves out.
    const config: JsonObject = {
      key_location: "header:X-API-Key",
      a_field_from_a_newer_gateway: { nested: [1, 2, 3] },
    };
    const values = readGuidedConfig(keyAuth, config);
    const edited = writeGuidedConfig(
      keyAuth,
      config,
      { ...values, key_location: { present: true, text: "query:api_key" } },
      values,
    );
    expect(edited.key_location).toBe("query:api_key");
    expect(edited.a_field_from_a_newer_gateway).toEqual({ nested: [1, 2, 3] });
  });

  it("keeps key order so an untouched round trip is stable", () => {
    const config: JsonObject = { hide_credentials: true, key_location: "header:X-Key" };
    expect(Object.keys(roundTrip(keyAuth, config))).toEqual([
      "hide_credentials",
      "key_location",
    ]);
  });

  it("round-trips every shipped default template unchanged", () => {
    for (const plugin of GUIDED_PLUGINS) {
      const schema = getGuidedSchema(plugin)!;
      const template = getPluginConfigDefault(plugin) as JsonObject;
      expect(schema.unsupported(template), `${plugin} template`).toBeNull();
      expect(JSON.stringify(roundTrip(schema, template)), plugin).toBe(
        JSON.stringify(template),
      );
    }
  });

  it("edits a nested rule without disturbing its siblings", () => {
    const config: JsonObject = {
      limit_by: "consumer",
      limits: [
        {
          scope: "default",
          requests_per_second: 400,
          an_unmodelled_rule_field: true,
        },
      ],
    };
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      {
        ...values,
        "limits.0.requests_per_second": { present: true, text: "900" },
      },
      values,
    );
    expect(edited.limits).toEqual([
      {
        scope: "default",
        requests_per_second: 900,
        an_unmodelled_rule_field: true,
      },
    ]);
  });
});

describe("omission and clear semantics", () => {
  it("keeps an absent field absent", () => {
    const config: JsonObject = { key_location: "header:X-API-Key" };
    expect("hide_credentials" in roundTrip(keyAuth, config)).toBe(false);
  });

  it("keeps an explicit null distinct from absent", () => {
    const config: JsonObject = { limit_by: null, limits: [{ scope: "default", requests_per_second: 1 }] };
    const result = roundTrip(rateLimiting, config);
    expect("limit_by" in result).toBe(true);
    expect(result.limit_by).toBeNull();
  });

  it("keeps literal `null` strings and surrounding whitespace when another field changes", () => {
    const config: JsonObject = {
      limits: [{ scope: "default", requests_per_second: 100 }],
      redis_key_prefix: "  null  ",
      redis_username: "null",
    };
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      { ...values, "limits.0.requests_per_second": { present: true, text: "200" } },
      values,
    );

    expect(edited.redis_key_prefix).toBe("  null  ");
    expect(edited.redis_username).toBe("null");
  });

  it("keeps explicitly null text fields null until the field is edited", () => {
    const config: JsonObject = {
      limits: [{ scope: "default", requests_per_second: 100 }],
      redis_key_prefix: null,
    };
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      { ...values, "limits.0.requests_per_second": { present: true, text: "200" } },
      values,
    );

    expect(edited.redis_key_prefix).toBeNull();
  });

  it("keeps an explicit null boolean when another field is edited", () => {
    const config: JsonObject = {
      key_location: "header:X-API-Key",
      hide_credentials: null,
    };
    const values = readGuidedConfig(keyAuth, config);
    const edited = writeGuidedConfig(
      keyAuth,
      config,
      { ...values, key_location: { present: true, text: "query:api_key" } },
      values,
    );

    expect(edited).toEqual({
      key_location: "query:api_key",
      hide_credentials: null,
    });
  });

  it("allows an explicit null boolean to be deliberately changed", () => {
    const config: JsonObject = { hide_credentials: null };
    const values = readGuidedConfig(keyAuth, config);
    const edited = writeGuidedConfig(
      keyAuth,
      config,
      {
        ...values,
        hide_credentials: { present: true, text: "true", checked: true },
      },
      values,
    );

    expect(edited.hide_credentials).toBe(true);
  });

  it("removes the key when a field is explicitly omitted", () => {
    const config: JsonObject = { key_location: "header:X-API-Key", hide_credentials: false };
    const values = readGuidedConfig(keyAuth, config);
    const edited = writeGuidedConfig(
      keyAuth,
      config,
      { ...values, hide_credentials: { ...values.hide_credentials!, present: false } },
      values,
    );
    expect("hide_credentials" in edited).toBe(false);
    expect(edited.key_location).toBe("header:X-API-Key");
  });

  it("keeps an explicitly empty list rather than dropping it", () => {
    const config: JsonObject = {
      allowed_origins: ["https://app.example.com"],
      exposed_headers: [],
    };
    const result = roundTrip(cors, config);
    expect(result.exposed_headers).toEqual([]);
  });
});

describe("secret-bearing fields", () => {
  const config: JsonObject = {
    limits: [{ scope: "default", requests_per_second: 10 }],
    sync_mode: "redis",
    redis_url: "redis://redis.internal:6379/0",
    redis_password: "a-real-password",
  };

  it("never reads the stored value into the editor", () => {
    const values = readGuidedConfig(rateLimiting, config);
    expect(values.redis_password).toEqual({ present: true, text: "", checked: undefined });
    expect(JSON.stringify(values)).not.toContain("a-real-password");
  });

  it("keeps the stored value when the operator does not type one", () => {
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      { ...values, sync_mode: { present: true, text: "local" } },
      values,
    );
    expect(edited.redis_password).toBe("a-real-password");
  });

  it("flags whitespace typed over a stored secret instead of saving it silently", () => {
    const values = readGuidedConfig(rateLimiting, config);
    const draft = { ...values, redis_password: { present: true, text: "   " } };
    const issues = validateGuidedConfig(rateLimiting, draft, config, values);
    expect(issues.map((issue) => issue.path)).toContain("redis_password");
  });

  it("replaces it when the operator types a new one", () => {
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      { ...values, redis_password: { present: true, text: "rotated" } },
      values,
    );
    expect(edited.redis_password).toBe("rotated");
  });

  it("removes it when the operator omits the field", () => {
    const values = readGuidedConfig(rateLimiting, config);
    const edited = writeGuidedConfig(
      rateLimiting,
      config,
      { ...values, redis_password: { present: false, text: "" } },
      values,
    );
    expect("redis_password" in edited).toBe(false);
  });
});

describe("unsupported shapes fall back rather than reshaping", () => {
  it("declines a multi-rule rate-limit policy", () => {
    const reason = rateLimiting.unsupported({
      limit_by: "consumer",
      limits: [
        { scope: "default", requests_per_second: 10 },
        { scope: "consumers", consumers: ["alice"], requests_per_second: 100 },
      ],
    });
    expect(reason).toContain("2 rate-limit rules");
  });

  it("declines Istio StringMatch origins instead of rewriting them", () => {
    const reason = cors.unsupported({
      allowed_origins: [{ prefix: "https://app." }],
    });
    expect(reason).toContain("StringMatch");
  });

  it("declines an Istio-projected CORS policy whose omissions mean something else", () => {
    expect(
      cors.unsupported({ allowed_origins: ["*"], unmatched_preflights: "ignore" }),
    ).toContain("unmatched_preflights");
  });

  it("accepts the ordinary shapes", () => {
    expect(cors.unsupported({ allowed_origins: ["https://app.example.com"] })).toBeNull();
    expect(
      rateLimiting.unsupported({ limits: [{ scope: "default", requests_per_second: 1 }] }),
    ).toBeNull();
  });
});

describe("validation", () => {
  function issuesFor(schema: typeof keyAuth, config: JsonObject, overrides: GuidedValues = {}) {
    const values = { ...readGuidedConfig(schema, config), ...overrides };
    const written = writeGuidedConfig(schema, config, values, values);
    return validateGuidedConfig(schema, values, written);
  }

  it("reports a numeric bound from the schema", () => {
    const issues = issuesFor(
      rateLimiting,
      { limits: [{ scope: "default", requests_per_second: 10 }] },
      { "limits.0.requests_per_second": { present: true, text: "2000000" } },
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain("at most 1000000");
  });

  it("reports a non-integer where the schema requires one", () => {
    const issues = issuesFor(
      rateLimiting,
      { limits: [{ scope: "default", requests_per_second: 10 }] },
      { "limits.0.requests_per_second": { present: true, text: "12.5" } },
    );
    expect(issues[0]?.message).toContain("whole number");
  });

  it("reports an enum value the schema does not allow", () => {
    const issues = issuesFor(
      rateLimiting,
      { limits: [{ scope: "default", requests_per_second: 10 }] },
      { sync_mode: { present: true, text: "postgres" } },
    );
    expect(issues[0]?.message).toContain("local, redis");
  });

  it("reports a required field that is not set", () => {
    const issues = issuesFor(cors, { allowed_origins: ["https://a.example"] }, {
      allowed_origins: { present: false, text: "" },
    });
    expect(issues[0]?.message).toContain("required");
  });

  it("reports a pattern the schema states, with its hint", () => {
    const issues = issuesFor(keyAuth, { key_location: "header:X-API-Key" }, {
      key_location: { present: true, text: "cookie:session" },
    });
    expect(issues[0]?.message).toContain("header:<name>");
  });

  it("reports an item pattern on a list", () => {
    const issues = issuesFor(cors, { allowed_origins: ["https://a.example"] }, {
      allowed_methods: { present: true, text: "GET\nNOT A METHOD" },
    });
    expect(issues[0]?.message).toContain("NOT A METHOD");
  });

  it("enforces the schema's mutually exclusive rate styles", () => {
    const issues = issuesFor(
      rateLimiting,
      { limits: [{ scope: "default", requests_per_second: 10, window_seconds: 60, max_requests: 5 }] },
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain("never both");
  });

  it("enforces that redis counters need an endpoint", () => {
    const issues = issuesFor(
      rateLimiting,
      { limits: [{ scope: "default", requests_per_second: 10 }], sync_mode: "redis" },
    );
    expect(issues.map((issue) => issue.path)).toContain("redis_url");
  });

  it("refuses credentials beside a wildcard origin", () => {
    const issues = issuesFor(cors, { allowed_origins: ["*"], allow_credentials: true });
    expect(issues[0]?.message).toContain("wildcard origin");
  });

  it("accepts a valid configuration", () => {
    expect(
      issuesFor(cors, {
        allowed_origins: ["https://app.example.com"],
        allowed_methods: ["GET", "POST"],
        max_age: 300,
      }),
    ).toEqual([]);
  });
});

describe("never stricter than the gateway", () => {
  const defaultRule = { limits: [{ scope: "default", requests_per_second: 5 }] };

  function issuesSeeded(config: JsonObject) {
    const values = readGuidedConfig(rateLimiting, config);
    const written = writeGuidedConfig(rateLimiting, config, values, values);
    return validateGuidedConfig(rateLimiting, values, written, values);
  }

  it("does not refuse a stored secret it deliberately left blank", () => {
    // Read as present-but-blank so it is never displayed; kept on write.
    // Treating that as "set but empty" made the config unsavable.
    expect(
      issuesSeeded({
        ...defaultRule,
        sync_mode: "redis",
        redis_url: "redis://redis.internal:6379/0",
        redis_password: "stored",
      }),
    ).toEqual([]);
  });

  it("still refuses a secret the operator newly set to an empty value", () => {
    const config: JsonObject = { ...defaultRule };
    const seeded = readGuidedConfig(rateLimiting, config);
    const values = { ...seeded, redis_password: { present: true, text: "" } };
    const written = writeGuidedConfig(rateLimiting, config, values, seeded);
    const issues = validateGuidedConfig(rateLimiting, values, written, seeded);
    expect(issues.map((issue) => issue.path)).toContain("redis_password");
  });

  it("accepts a Redis URL with a bare trailing slash", () => {
    expect(
      issuesSeeded({ ...defaultRule, sync_mode: "redis", redis_url: "redis://redis.internal:6379/" }),
    ).toEqual([]);
  });

  it("hands a non-canonical enum spelling to the JSON editor instead of refusing it", () => {
    for (const limit_by of ["Consumer", "IP", "spiffe"]) {
      expect(
        unmodelledEnumSpelling(rateLimiting, { ...defaultRule, limit_by }),
        limit_by,
      ).toContain(JSON.stringify(limit_by));
    }
    expect(unmodelledEnumSpelling(rateLimiting, { ...defaultRule, limit_by: "consumer" })).toBeNull();
    expect(unmodelledEnumSpelling(rateLimiting, { ...defaultRule, limit_by: null })).toBeNull();
    expect(unmodelledEnumSpelling(rateLimiting, { ...defaultRule, sync_mode: "Redis" })).toContain(
      "sync_mode",
    );
  });
});

describe("integer drafts", () => {
  it("never writes an empty integer field as 0", () => {
    const config: JsonObject = { max_age: 600 };
    const values = readGuidedConfig(cors, config);
    const edited = writeGuidedConfig(
      cors,
      config,
      { ...values, max_age: { present: true, text: "" } },
      values,
    );
    expect(edited.max_age).not.toBe(0);
    expect(edited.max_age).toBe("");
  });

  it("writes a typed integer as a number", () => {
    const config: JsonObject = { max_age: 600 };
    const values = readGuidedConfig(cors, config);
    const edited = writeGuidedConfig(
      cors,
      config,
      { ...values, max_age: { present: true, text: " 120 " } },
      values,
    );
    expect(edited.max_age).toBe(120);
  });
});
