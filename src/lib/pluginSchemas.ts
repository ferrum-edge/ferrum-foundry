/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – guided plugin configuration schemas               */
/* ------------------------------------------------------------------ */

/**
 * Field descriptors for the plugins Foundry offers guided configuration for.
 *
 * ## Provenance
 *
 * Every descriptor below is derived from a named schema component in the
 * canonical Ferrum Edge `openapi.yaml` — labels, descriptions, enums, bounds,
 * and patterns are transcriptions of that schema, not invented UI copy. The
 * exact upstream revision and the SHA-256 of each source block are pinned in
 * `PLUGIN_SCHEMA_PROVENANCE`, and `scripts/plugin-schema-drift.mjs` re-fetches
 * the spec on every pull request and fails when a block changes. Foundry does
 * not keep a copy of the spec (see CLAUDE.md); what is stored here is the
 * reviewed reduction plus the digest that proves what it was reviewed against.
 *
 * ## Scope
 *
 * Guided editing is assistance, not authority. It covers the fields these four
 * plugins need for the launch workflows; the raw JSON editor remains, every
 * unmodelled key round-trips untouched, and gateway admission is still the
 * only thing that decides whether a configuration is valid. A configuration
 * whose shape these descriptors cannot represent is reported as unsupported
 * and edited as JSON — never silently reshaped.
 */

import type { JsonValue } from "./pluginConfigDefaults";

export interface SchemaProvenance {
  /** Component name under `components.schemas` in the upstream spec. */
  readonly component: string;
  /** SHA-256 of the component's YAML block, LF-joined, trailing blanks trimmed. */
  readonly sha256: string;
}

/**
 * The upstream revision these descriptors were reviewed against.
 * `scripts/plugin-schema-drift.mjs` verifies every digest below.
 */
export const PLUGIN_SCHEMA_SPEC = {
  repository: "ferrum-edge/ferrum-edge",
  path: "openapi.yaml",
  /** Commit that last touched `openapi.yaml` when these were transcribed. */
  ref: "65a23411841dd363497f98c7d40f5a66ed7d1942",
  /** `info.version` at that revision. */
  version: "0.2.0",
} as const;

export const PLUGIN_SCHEMA_PROVENANCE: readonly SchemaProvenance[] = [
  {
    component: "KeyAuthConfig",
    sha256: "2489182cc16c230dd69d984441a2efcee271df44a934a8ca6d5d868f77da4deb",
  },
  {
    component: "RateLimitingConfig",
    sha256: "3ba160df5e20745939284d67655d5dcc5cee4766e424a0a31846c0740980ed5d",
  },
  {
    component: "RateLimitingRuleConfig",
    sha256: "baeb7755166ff2af60d33fdc8eff36e94fb04e5b15ef099c69792a064eb2489d",
  },
  {
    component: "CorsConfig",
    sha256: "96fcc1b45b3c20b27713b0bc0c7eef23bd92810587b21115a233081da7932bf3",
  },
  {
    component: "PrometheusMetricsConfig",
    sha256: "ee96fad934766a3195cd0aa2231c55287732973f246bf4a830e4ae890b980623",
  },
];

/* ------------------------------------------------------------------ */
/*  Field model                                                        */
/* ------------------------------------------------------------------ */

export type GuidedFieldKind = "text" | "integer" | "boolean" | "enum" | "stringList";

export interface GuidedField {
  /** Key within the section's object. */
  readonly key: string;
  readonly label: string;
  readonly kind: GuidedFieldKind;
  /** Transcribed from the schema's own `description`. */
  readonly description: string;
  readonly required?: boolean;
  /** What omitting the field means, when the schema documents a default. */
  readonly omissionMeans?: string;
  readonly enumValues?: readonly { readonly value: string; readonly label: string }[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: RegExp;
  readonly patternHint?: string;
  readonly itemPattern?: RegExp;
  readonly itemPatternHint?: string;
  /**
   * Something only the gateway or the deployment can confirm. Shown as a note,
   * never as a satisfied check — Foundry does not know whether it holds.
   */
  readonly prerequisite?: string;
  /**
   * Credential material. Never placed in browser storage, never echoed into a
   * diff or a log, and cleared rather than round-tripped through the guided
   * view when the operator has not typed it.
   */
  readonly secret?: boolean;
}

export interface GuidedSection {
  readonly title: string;
  /**
   * Where the section's object lives in the configuration. `""` is the config
   * root; `"limits.0"` is the first element of the `limits` array.
   */
  readonly path: string;
  readonly description?: string;
  readonly fields: readonly GuidedField[];
}

export interface PluginGuidedSchema {
  readonly plugin: string;
  readonly summary: string;
  readonly components: readonly string[];
  readonly sections: readonly GuidedSection[];
  /**
   * Why this configuration cannot be edited in the guided view, or `null` when
   * it can. Returning a reason is a supported outcome: the editor falls back to
   * raw JSON and says why, rather than dropping the fields it cannot model.
   */
  readonly unsupported: (config: Readonly<Record<string, JsonValue>>) => string | null;
  /** Cross-field rules the schema states but a single field cannot check. */
  readonly crossFieldErrors?: (
    config: Readonly<Record<string, JsonValue>>,
  ) => readonly { readonly path: string; readonly message: string }[];
}

/* ------------------------------------------------------------------ */
/*  key_auth — components.schemas.KeyAuthConfig                        */
/* ------------------------------------------------------------------ */

const KEY_AUTH: PluginGuidedSchema = {
  plugin: "key_auth",
  summary: "API key authentication.",
  components: ["KeyAuthConfig"],
  unsupported: () => null,
  sections: [
    {
      title: "Credential location",
      path: "",
      fields: [
        {
          key: "key_location",
          label: "Key location",
          kind: "text",
          description:
            "Exact credential location (header:<name> or query:<name>). Whitespace is not trimmed; header names must be valid HTTP tokens, and query names must be non-empty and contain no whitespace.",
          omissionMeans: "header:X-API-Key",
          pattern: /^(header:[!#$%&'*+.^_`|~0-9A-Za-z-]+|query:\S+)$/,
          patternHint:
            "Use header:<name> or query:<name>, for example header:X-API-Key.",
          prerequisite:
            "Consumers must hold a keyauth credential for this proxy; the gateway rejects requests whose key matches no consumer.",
        },
        {
          key: "hide_credentials",
          label: "Hide credentials from the backend",
          kind: "boolean",
          description:
            "Remove the configured API-key header or query parameter before forwarding an authenticated request upstream, including when another mechanism wins a multi-auth chain. Disable only when a legacy backend explicitly requires the reusable credential.",
          omissionMeans: "true",
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  rate_limiting — RateLimitingConfig + RateLimitingRuleConfig        */
/* ------------------------------------------------------------------ */

function asArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function isPlainObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RATE_LIMITING: PluginGuidedSchema = {
  plugin: "rate_limiting",
  summary: "Per-IP, per-consumer, or per-SPIFFE-identity request rate limiting.",
  components: ["RateLimitingConfig", "RateLimitingRuleConfig"],
  unsupported: (config) => {
    const limits = asArray(config.limits);
    if (limits === null) {
      return "`limits` is required and must be an array of rules.";
    }
    if (limits.length !== 1) {
      return (
        "This configuration has " +
        `${limits.length} rate-limit rules. The guided view models the single ` +
        "`scope: default` rule; edit multi-rule policies, including per-consumer " +
        "rules, as JSON."
      );
    }
    const rule = limits[0];
    if (!isPlainObject(rule)) return "The rate-limit rule is not an object.";
    const scope = typeof rule.scope === "string" ? rule.scope.toLowerCase() : "";
    if (scope !== "default") {
      return (
        `The single rule has \`scope: ${String(rule.scope)}\`. The guided view ` +
        "models the `scope: default` rule; edit consumer-scoped rules as JSON."
      );
    }
    return null;
  },
  crossFieldErrors: (config) => {
    const errors: { path: string; message: string }[] = [];
    const rule = asArray(config.limits)?.[0];
    if (isPlainObject(rule)) {
      const presets = ["requests_per_second", "requests_per_minute", "requests_per_hour"]
        .filter((key) => rule[key] !== undefined);
      const window = ["window_seconds", "max_requests"].filter(
        (key) => rule[key] !== undefined,
      );
      if (presets.length > 0 && window.length > 0) {
        errors.push({
          path: "limits.0.window_seconds",
          message:
            "A rule uses either the preset rates or the custom window pair, never both.",
        });
      }
      if (presets.length === 0 && window.length === 0) {
        errors.push({
          path: "limits.0.requests_per_second",
          message:
            "Set at least one preset rate, or both custom-window fields.",
        });
      }
      if (window.length === 1) {
        errors.push({
          path: window[0] === "window_seconds" ? "limits.0.max_requests" : "limits.0.window_seconds",
          message: "`window_seconds` and `max_requests` must be set together.",
        });
      }
    }
    const syncMode = typeof config.sync_mode === "string" ? config.sync_mode.toLowerCase() : "";
    if (syncMode === "redis" && !config.redis_url) {
      errors.push({
        path: "redis_url",
        message:
          "Centralized counters need an endpoint: the gateway refuses `sync_mode: redis` without `redis_url` rather than falling back to local.",
      });
    }
    return errors;
  },
  sections: [
    {
      title: "Rate limit",
      path: "limits.0",
      description:
        "The `scope: default` rule, which applies to every key without a more specific consumer rule and to IP fallback.",
      fields: [
        {
          key: "requests_per_second",
          label: "Requests per second",
          kind: "integer",
          description: "Max requests per second.",
          minimum: 1,
          maximum: 1_000_000,
        },
        {
          key: "requests_per_minute",
          label: "Requests per minute",
          kind: "integer",
          description: "Max requests per minute.",
          minimum: 1,
          maximum: 1_000_000,
        },
        {
          key: "requests_per_hour",
          label: "Requests per hour",
          kind: "integer",
          description: "Max requests per hour.",
          minimum: 1,
          maximum: 1_000_000,
        },
        {
          key: "window_seconds",
          label: "Custom window (seconds)",
          kind: "integer",
          description:
            "Custom rate-limit window length in seconds. Must be paired with the maximum below, and cannot be combined with the preset rates. Capped at 2678400 (31 days).",
          minimum: 1,
          maximum: 2_678_400,
        },
        {
          key: "max_requests",
          label: "Requests per custom window",
          kind: "integer",
          description:
            "Maximum requests permitted within the custom window. Capped at 1000000 as an operational budget ceiling.",
          minimum: 1,
          maximum: 1_000_000,
        },
      ],
    },
    {
      title: "Policy",
      path: "",
      fields: [
        {
          key: "limit_by",
          label: "Limit by",
          kind: "enum",
          description:
            "Rate limit key. `ip` uses the client IP; `consumer` uses the identified consumer and falls back to client IP when none is present; `spiffe_identity` uses the SPIFFE ID from the peer certificate and falls back to client IP.",
          omissionMeans: "ip",
          enumValues: [
            { value: "ip", label: "Client IP" },
            { value: "consumer", label: "Identified consumer" },
            { value: "spiffe_identity", label: "SPIFFE identity" },
          ],
        },
        {
          key: "expose_headers",
          label: "Expose x-ratelimit-* headers",
          kind: "boolean",
          description:
            "Inject x-ratelimit-* headers on requests and responses. When several rate_limiting instances run on a route exactly one verdict is published.",
          omissionMeans: "false",
        },
      ],
    },
    {
      title: "Counter storage",
      path: "",
      description:
        "Local counters are per gateway process. Centralized counters coordinate limits across instances.",
      fields: [
        {
          key: "sync_mode",
          label: "Sync mode",
          kind: "enum",
          description:
            "Rate limit state storage: local (in-memory per instance) or redis (centralized across instances). Database-backed counters are unsupported.",
          omissionMeans: "local",
          enumValues: [
            { value: "local", label: "Local (per gateway process)" },
            { value: "redis", label: "Redis (shared across instances)" },
          ],
        },
        {
          key: "redis_url",
          label: "Redis URL",
          kind: "text",
          description:
            "Redis connection URL (for example redis://host:6379/0), required with sync_mode=redis. Any RESP-compatible server works. URL fragments are forbidden.",
          pattern: /^rediss?:\/\/[^/?#\s]+(\/\d{1,10})?(\?[^\s#]*)?$/i,
          patternHint: "For example redis://redis.internal:6379/0",
          prerequisite:
            "The gateway must be able to reach this endpoint through its egress policy; Redis Cluster is not supported.",
        },
        {
          key: "redis_tls",
          label: "Use TLS for Redis",
          kind: "boolean",
          description:
            "Enable TLS for the Redis connection (upgrades redis:// to rediss://). CA verification uses the gateway-level FERRUM_TLS_CA_BUNDLE_PATH.",
          omissionMeans: "false",
          prerequisite:
            "Trust material is gateway-level configuration (FERRUM_TLS_CA_BUNDLE_PATH); Foundry cannot confirm it is present.",
        },
        {
          key: "redis_key_prefix",
          label: "Redis key prefix",
          kind: "text",
          description:
            "Key prefix for all Redis keys. Setting this explicitly is the documented opt-in for a deliberately shared budget: every instance with the same prefix increments the same counters.",
          omissionMeans:
            "{FERRUM_NAMESPACE}:rate_limiting:{plugin-config-id} — an independent budget per policy",
        },
        {
          key: "redis_pool_size",
          label: "Redis pool size",
          kind: "integer",
          description: "Number of multiplexed Redis connections.",
          minimum: 1,
          maximum: 128,
          omissionMeans: "4",
        },
        {
          key: "redis_username",
          label: "Redis username",
          kind: "text",
          description: "Redis username for ACL-based authentication (Redis 6+).",
        },
        {
          key: "redis_password",
          label: "Redis password",
          kind: "text",
          description: "Redis password for authentication.",
          secret: true,
        },
        {
          key: "redis_failure_policy",
          label: "When Redis is unreachable",
          kind: "enum",
          description:
            "fail_closed refuses the request with 503 and no rate-limit headers. local_fallback uses per-process budgets, which enforce the configured limit once per gateway process.",
          omissionMeans: "local_fallback",
          enumValues: [
            { value: "local_fallback", label: "Fall back to per-process budgets" },
            { value: "fail_closed", label: "Refuse the request (503)" },
          ],
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  cors — components.schemas.CorsConfig                               */
/* ------------------------------------------------------------------ */

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const CORS: PluginGuidedSchema = {
  plugin: "cors",
  summary: "Cross-Origin Resource Sharing policy.",
  components: ["CorsConfig"],
  unsupported: (config) => {
    const origins = asArray(config.allowed_origins);
    if (origins === null) {
      return "`allowed_origins` is required and must be an array.";
    }
    if (origins.some((origin) => typeof origin !== "string")) {
      return (
        "This policy uses Istio `StringMatch` origin objects (exact / prefix / " +
        "regex). Their matching semantics are deliberately different from the " +
        "native string form, so the guided view does not rewrite them — edit " +
        "this policy as JSON."
      );
    }
    if (config.unmatched_preflights !== undefined) {
      return (
        "`unmatched_preflights` marks an Istio-projected policy, which changes " +
        "what omitted method, header, and max-age fields mean. Edit it as JSON " +
        "so those omissions are preserved exactly."
      );
    }
    return null;
  },
  crossFieldErrors: (config) => {
    const origins = asArray(config.allowed_origins) ?? [];
    if (
      config.allow_credentials === true &&
      origins.some((origin) => origin === "*")
    ) {
      return [
        {
          path: "allow_credentials",
          message:
            "Credentials cannot be combined with a wildcard origin: the gateway logs a warning and disables credentials.",
        },
      ];
    }
    return [];
  },
  sections: [
    {
      title: "Origins",
      path: "",
      fields: [
        {
          key: "allowed_origins",
          label: "Allowed origins",
          kind: "stringList",
          required: true,
          description:
            'Permitted-origin policy, bounded at 64 entries. Each entry is "*" for intentional allow-all, an exact scheme://host[:port] origin, or a *.suffix.com wildcard-subdomain pattern.',
          minItems: 1,
          maxItems: 64,
        },
        {
          key: "allow_credentials",
          label: "Allow credentials",
          kind: "boolean",
          description:
            "Send Access-Control-Allow-Credentials: true. Incompatible with wildcard origins, which the gateway refuses or silently disables rather than weakening.",
          omissionMeans: "false",
        },
      ],
    },
    {
      title: "Preflight",
      path: "",
      description:
        "These lists govern preflight responses only. They are not evaluated against the actual request.",
      fields: [
        {
          key: "allowed_methods",
          label: "Allowed methods",
          kind: "stringList",
          description:
            "Preflight-only allowed methods returned in Access-Control-Allow-Methods. Method tokens are case-sensitive.",
          itemPattern: HTTP_TOKEN,
          itemPatternHint: "Each entry must be an HTTP method token, e.g. GET.",
          omissionMeans:
            'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        },
        {
          key: "allowed_headers",
          label: "Allowed request headers",
          kind: "stringList",
          description:
            "Preflight-only allowed request headers returned in Access-Control-Allow-Headers. Header names are case-insensitive. With credentials disabled, `*` permits every header except Authorization, which must be listed explicitly.",
          itemPattern: HTTP_TOKEN,
          itemPatternHint: "Each entry must be an HTTP header token.",
          omissionMeans: "Accept, Authorization, Content-Type, Origin, X-Requested-With",
        },
        {
          key: "exposed_headers",
          label: "Exposed response headers",
          kind: "stringList",
          description: "Response headers exposed to browser JavaScript.",
          itemPattern: HTTP_TOKEN,
          itemPatternHint: "Each entry must be an HTTP header token.",
          omissionMeans: "none",
        },
        {
          key: "max_age",
          label: "Preflight cache (seconds)",
          kind: "integer",
          description: "Preflight cache duration in seconds.",
          minimum: 0,
          omissionMeans: "86400",
        },
        {
          key: "preflight_continue",
          label: "Pass preflights to the backend",
          kind: "boolean",
          description:
            "Pass allowed preflights to the backend. Backend status and body are retained, but every Access-Control response field is replaced by the gateway-authoritative policy.",
          omissionMeans: "false",
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  prometheus_metrics — components.schemas.PrometheusMetricsConfig    */
/* ------------------------------------------------------------------ */

const PROMETHEUS_METRICS: PluginGuidedSchema = {
  plugin: "prometheus_metrics",
  summary: "Exports gateway metrics in Prometheus format.",
  components: ["PrometheusMetricsConfig"],
  unsupported: () => null,
  sections: [
    {
      title: "Rendering and retention",
      path: "",
      description:
        "At most one enabled instance is permitted and it must use global scope, because the registry and these tunables are process-wide.",
      fields: [
        {
          key: "render_cache_ttl_seconds",
          label: "Render cache TTL (seconds)",
          kind: "integer",
          description:
            "How long the cached /metrics response is served before rebuilding.",
          minimum: 0,
          omissionMeans: "5",
        },
        {
          key: "stale_entry_ttl_seconds",
          label: "Stale entry TTL (seconds)",
          kind: "integer",
          description:
            "How long idle metric entries live before eviction. Prevents unbounded memory growth from deleted or recreated proxies.",
          minimum: 0,
          omissionMeans: "3600",
        },
        {
          key: "mesh_series_budget_per_family",
          label: "Mesh series budget per family",
          kind: "integer",
          description:
            "Hard ceiling on live mesh series retained per metric family. Newly observed keys beyond the budget are dropped until eviction frees capacity. There is no unlimited mode.",
          minimum: 1,
          maximum: 1_000_000,
          omissionMeans: "10000",
        },
        {
          key: "cache_invalidation_min_age_ms",
          label: "Cache invalidation minimum age (ms)",
          kind: "integer",
          description:
            "Minimum age of the render cache before a record can invalidate it. Under extreme load this prevents an allocation per request.",
          minimum: 0,
          omissionMeans: "500",
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */

const SCHEMAS: Record<string, PluginGuidedSchema> = {
  key_auth: KEY_AUTH,
  rate_limiting: RATE_LIMITING,
  cors: CORS,
  prometheus_metrics: PROMETHEUS_METRICS,
};

/** The plugins guided configuration currently covers. */
export const GUIDED_PLUGINS: readonly string[] = Object.keys(SCHEMAS).sort();

export function getGuidedSchema(pluginName: string): PluginGuidedSchema | undefined {
  return SCHEMAS[pluginName];
}
