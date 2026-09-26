/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – submitted secrets in rejected writes              */
/*                                                                    */
/*  A write that carries a secret — a consumer's credentials, a plugin */
/*  configuration's keys, TLS private key material — can be refused   */
/*  with a body that repeats it. ky's error also holds the request's  */
/*  options, body included, for as long as anything references it.   */
/*  A failed secret-bearing write is therefore replaced by a          */
/*  `RedactedWriteError`: the gateway's status and body with every    */
/*  submitted secret removed, and nothing else from the request.      */
/* ------------------------------------------------------------------ */

import { isRedactedField } from "@/lib/resourceBaseline";
import type { ApiError } from "./types";
import {
  extractApiErrorData,
  extractApiErrorDetail,
  getCommittedWrite,
  isUnobservedWrite,
  markCommittedWrite,
  markUnobservedWrite,
  onApiError,
  takeHeldReport,
} from "./client";

/** What a submitted secret is replaced with, the gateway's own read marker. */
export const REDACTION_MARKER = "[REDACTED]";

/** Every string a payload carries: the values a credential write must not echo. */
export function submittedValues(data: unknown): string[] {
  if (typeof data === "string") return data ? [data] : [];
  if (Array.isArray(data)) return data.flatMap(submittedValues);
  if (data && typeof data === "object") return Object.values(data).flatMap(submittedValues);
  return [];
}

/**
 * Field names whose value is credential material beyond the conflict dialog's
 * list (`isRedactedField`): the ones Ferrum Edge's plugin projection also
 * treats as secret — authentication header maps, webhook targets, service
 * account documents, and camelCase `*Key` fields `_key$` does not match.
 */
const SECRET_FIELD_EXTRA =
  /(headers$|webhook|service[_-]?account|(access|function|integrity)[_-]?key)/i;

function isSecretField(field: string): boolean {
  return isRedactedField(field) || SECRET_FIELD_EXTRA.test(field);
}

// scheme://[userinfo@]host[:port][path][?query][#fragment]. Userinfo runs to
// the last `@` before the path, so a password containing `@` is taken whole.
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\/(?:([^/?#\s]*)@)?[^/?#\s@]*(\S*)$/i;

/**
 * The parts of a URL that can carry a credential: userinfo, and a path, query
 * or fragment (collector vendors put tokens in the path and the query). A bare
 * `scheme://host[:port]` carries none and stays readable in the detail.
 */
function urlSecrets(value: string): string[] {
  const match = ABSOLUTE_URL.exec(value.trim());
  if (!match) return [];
  const userinfo = match[1] ?? "";
  const rest = match[2] === "/" ? "" : match[2];
  if (!userinfo && !rest) return [];
  return [value, userinfo, rest].filter(Boolean);
}

/* ---------- Plugin configurations: Ferrum Edge's projection ---------- */

/**
 * How Ferrum Edge projects a schema-declared plugin `config` path for a
 * non-admin read (`FieldSensitivity` in Edge v0.9.7
 * `src/admin/plugin_config_projection.rs`), and so which of its values a
 * failed write must not echo: a `secret` wholesale, the credential-bearing
 * parts of an `endpoint` or `redis` URL (the whole value when it is not a
 * URL), and every `kafka` producer property off the safe list.
 */
type Sensitivity = "secret" | "endpoint" | "redis" | "kafka";

interface SensitivityRule {
  readonly path: readonly string[];
  readonly sensitivity: Sensitivity;
}

const secret = (...path: string[]): SensitivityRule => ({ path, sensitivity: "secret" });
const endpoint = (...path: string[]): SensitivityRule => ({ path, sensitivity: "endpoint" });
const redis = (...path: string[]): SensitivityRule => ({ path, sensitivity: "redis" });
const REDIS_BACKED = [redis("redis_url")];
const NONE: readonly SensitivityRule[] = [];

/**
 * Edge v0.9.7's `PLUGIN_SENSITIVITY_SCHEMAS`, transcribed rule for rule. A
 * plugin named here gets its rules plus the name floor and URL sweep below; a
 * plugin not named here (a custom plugin, or a built-in added after v0.9.7)
 * has no schema Foundry can classify by, so every string it carries is secret.
 */
const PLUGIN_SENSITIVITY = new Map<string, readonly SensitivityRule[]>([
  ["otel_tracing", [endpoint("endpoint"), secret("authorization"), secret("headers", "*")]],
  ["correlation_id", NONE],
  ["cors", NONE],
  ["request_termination", NONE],
  ["mesh_outbound_registry", NONE],
  ["ip_restriction", NONE],
  ["geo_restriction", NONE],
  ["bot_detection", NONE],
  ["spec_expose", [endpoint("spec_url")]],
  ["sse", NONE],
  ["grpc_web", NONE],
  ["grpc_method_router", REDIS_BACKED],
  ["spiffe_identity", NONE],
  ["mtls_auth", NONE],
  ["jwks_auth", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "jwks_uri"),
    endpoint("discovery_url"),
    endpoint("jwks_uri"),
  ]],
  ["oauth2_introspection", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "introspection_endpoint"),
    endpoint("discovery_url"),
    endpoint("introspection_endpoint"),
  ]],
  ["oidc_relying_party", [
    endpoint("providers", "*", "discovery_url"),
    endpoint("providers", "*", "jwks_uri"),
    endpoint("providers", "*", "token_endpoint"),
    endpoint("providers", "*", "authorization_endpoint"),
    endpoint("providers", "*", "userinfo_endpoint"),
    endpoint("providers", "*", "end_session_endpoint"),
    endpoint("discovery_url"),
    endpoint("jwks_uri"),
    endpoint("token_endpoint"),
    endpoint("authorization_endpoint"),
    endpoint("userinfo_endpoint"),
    endpoint("end_session_endpoint"),
  ]],
  ["jwt_auth", NONE],
  ["key_auth", NONE],
  ["ldap_auth", [endpoint("ldap_url")]],
  ["basic_auth", NONE],
  ["hmac_auth", NONE],
  ["soap_ws_security", NONE],
  ["access_control", NONE],
  ["tcp_connection_throttle", NONE],
  ["mesh_authz", NONE],
  ["opa", [secret("headers", "*")]],
  ["adaptive_concurrency", NONE],
  ["request_deduplication", REDIS_BACKED],
  ["request_size_limiting", NONE],
  ["ws_message_size_limiting", NONE],
  ["graphql", REDIS_BACKED],
  ["rate_limiting", REDIS_BACKED],
  ["ws_rate_limiting", REDIS_BACKED],
  ["udp_rate_limiting", REDIS_BACKED],
  ["ai_transcript_audit", [
    endpoint("sink", "endpoint_url"),
    secret("sink", "custom_headers", "*"),
    endpoint("endpoint_url"),
    secret("headers", "*"),
    secret("custom_headers", "*"),
  ]],
  ["ai_prompt_shield", NONE],
  ["waf", NONE],
  ["fault_injection", NONE],
  ["body_validator", NONE],
  ["openapi_validator", NONE],
  ["ai_semantic_firewall", [endpoint("provider", "endpoint")]],
  ["ai_request_guard", NONE],
  ["ai_tool_governor", [endpoint("endpoint_url"), endpoint("approval", "endpoint_url")]],
  ["ai_stream_router", [endpoint("providers", "*", "endpoint")]],
  ["mcp_gateway", [endpoint("servers", "*", "upstream_url"), endpoint("upstream_url")]],
  ["a2a_gateway", NONE],
  ["mesh_route_dispatch", NONE],
  ["ai_semantic_cache", [
    redis("redis_url"),
    endpoint("semantic_embedding_endpoint"),
    secret("semantic_embedding_auth_header"),
  ]],
  ["request_transformer", NONE],
  ["serverless_function", [
    endpoint("function_url"),
    endpoint("aws_endpoint_url"),
    secret("azure_function_key"),
  ]],
  ["response_mock", NONE],
  ["grpc_deadline", NONE],
  ["load_testing", NONE],
  ["request_mirror", NONE],
  ["response_size_limiting", NONE],
  ["response_caching", NONE],
  ["response_transformer", NONE],
  ["compression", NONE],
  ["ai_prompt_compressor", NONE],
  ["ai_federation", [endpoint("base_url"), endpoint("providers", "*", "base_url")]],
  ["ai_response_guard", NONE],
  ["security_headers", NONE],
  ["ai_token_metrics", NONE],
  ["ai_rate_limiter", REDIS_BACKED],
  ["stdout_logging", NONE],
  ["ws_frame_logging", NONE],
  ["statsd_logging", NONE],
  ["http_logging", [endpoint("endpoint_url"), secret("custom_headers", "*")]],
  ["tcp_logging", NONE],
  ["kafka_logging", [{ path: ["producer_config"], sensitivity: "kafka" }]],
  ["loki_logging", [
    endpoint("endpoint_url"),
    secret("authorization_header"),
    secret("custom_headers", "*"),
  ]],
  ["udp_logging", NONE],
  ["ws_logging", [endpoint("endpoint_url")]],
  ["transaction_debugger", NONE],
  ["proxy_alerts", [
    endpoint("channels", "*", "webhook_url"),
    endpoint("channels", "*", "url"),
    secret("channels", "*", "headers", "*"),
    secret("channels", "*", "body_template"),
  ]],
  ["prometheus_metrics", NONE],
  ["api_chargeback", NONE],
  ["api_chargeback_sink", [
    endpoint("clickhouse", "url"),
    secret("clickhouse", "insert_query_params", "*"),
  ]],
  ["workload_metrics", [
    endpoint("tracing_provider", "config", "url"),
    endpoint("tracing_provider", "config", "agent_url"),
    endpoint("tracing_provider", "config", "collector_url"),
    endpoint("tracing_provider", "config", "endpoint"),
    endpoint("tracing_providers", "*", "config", "url"),
    endpoint("tracing_providers", "*", "config", "agent_url"),
    endpoint("tracing_providers", "*", "config", "collector_url"),
    endpoint("tracing_providers", "*", "config", "endpoint"),
  ]],
  ["__mesh_bpf_metrics", NONE],
  ["transaction_log_schema", NONE],
]);

/**
 * Edge's `KAFKA_SAFE_PRODUCER_PROPERTIES`: the librdkafka properties that carry
 * no credential. Every other `producer_config` property — `ssl.key.pem`,
 * `sasl.password`, and whatever librdkafka marks sensitive next — is secret.
 */
const KAFKA_SAFE_PRODUCER_PROPERTIES = new Set([
  "acks",
  "batch.num.messages",
  "batch.size",
  "client.id",
  "compression.codec",
  "compression.level",
  "compression.type",
  "delivery.timeout.ms",
  "enable.idempotence",
  "linger.ms",
  "max.in.flight",
  "max.in.flight.requests.per.connection",
  "message.max.bytes",
  "message.send.max.retries",
  "message.timeout.ms",
  "metadata.max.age.ms",
  "partitioner",
  "queue.buffering.max.kbytes",
  "queue.buffering.max.messages",
  "queue.buffering.max.ms",
  "reconnect.backoff.max.ms",
  "reconnect.backoff.ms",
  "request.required.acks",
  "request.timeout.ms",
  "retries",
  "retry.backoff.max.ms",
  "retry.backoff.ms",
  "socket.keepalive.enable",
  "socket.nagle.disable",
  "socket.timeout.ms",
  "sticky.partitioning.linger.ms",
  "topic.metadata.refresh.interval.ms",
]);

/** Edge's `normalize_config_key`: case and `-`, `.`, `_` do not distinguish keys. */
function normalizeConfigKey(key: string): string {
  return key.replace(/[-._]/g, "").toLowerCase();
}

/** Edge's `DEFAULT_SENSITIVE_METADATA_KEYS`, matched as case-insensitive substrings. */
const SENSITIVE_METADATA_SUBSTRINGS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "cache_request_headers_snapshot",
  "grpc_web_shadowed_trailers",
  "claim_header.",
  "bearer",
  "password",
  "secret",
  "last_event_id",
  "last-event-id",
];

/** The substrings Edge's `is_sensitive_plugin_config_key` matches on a normalized key. */
const SENSITIVE_NORMALIZED_SUBSTRINGS = [
  "integritykey",
  "apikey",
  "accesskey",
  "functionkey",
  "clientsecret",
  "credential",
  "privatekey",
  "serviceaccountjson",
  "webhook",
];

/** A key's words, split at delimiters and case changes (`APIKey` → `API`, `Key`). */
function keySegments(key: string): string[] {
  return key.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z0-9]+/g) ?? [];
}

/**
 * Edge's name floor for a plugin `config` key (`is_sensitive_plugin_config_key`
 * over `is_sensitive_metadata_key`), without the operator's
 * `FERRUM_LOG_REDACT_METADATA_KEYS` extras, which Foundry cannot see.
 */
function isEdgeSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  const segments = keySegments(key).map((segment) => segment.toLowerCase());
  const normalized = normalizeConfigKey(key);
  return (
    // Internal-only metadata keys, which Edge also treats as sensitive.
    lower.startsWith("mesh.metrics.") ||
    lower === "grpc_web.request_trailers" ||
    (key.startsWith("_") && segments[0] === "dedup") ||
    SENSITIVE_METADATA_SUBSTRINGS.some((needle) => lower.includes(needle)) ||
    segments.includes("token") ||
    segments.includes("apikey") ||
    (segments.includes("api") && segments.includes("key")) ||
    normalized === "key" ||
    SENSITIVE_NORMALIZED_SUBSTRINGS.some((needle) => normalized.includes(needle))
  );
}

/** A value Edge projects as `sensitivity`, as the submitted strings it must not echo. */
function projectedSecrets(value: unknown, sensitivity: Sensitivity): string[] {
  if (value === null || value === undefined) return [];
  if (sensitivity === "endpoint" || sensitivity === "redis") {
    // Edge fails closed on a value it cannot decompose as a URL.
    return typeof value === "string" && ABSOLUTE_URL.test(value.trim())
      ? urlSecrets(value)
      : submittedValues(value);
  }
  if (sensitivity === "kafka" && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([property, setting]) =>
      KAFKA_SAFE_PRODUCER_PROPERTIES.has(property.trim().toLowerCase())
        ? []
        : submittedValues(setting));
  }
  return submittedValues(value);
}

/**
 * Edge's `apply_rule`: `*` names each entry of an object or array, a named
 * segment matches normalized keys and passes through arrays, and a scalar
 * where the rule expects a container is secret.
 */
function ruleSecrets(value: unknown, path: readonly string[], sensitivity: Sensitivity): string[] {
  if (path.length === 0) return projectedSecrets(value, sensitivity);
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.flatMap((item) => head === "*"
      ? ruleSecrets(item, rest, sensitivity)
      : ruleSecrets(item, path, sensitivity));
  }
  if (value && typeof value === "object") {
    const wanted = normalizeConfigKey(head);
    return Object.entries(value).flatMap(([key, child]) =>
      head === "*" || normalizeConfigKey(key) === wanted
        ? ruleSecrets(child, rest, sensitivity)
        : []);
  }
  return projectedSecrets(value, "secret");
}

/**
 * Edge's floor beneath the schema (`redact_sensitive_plugin_config_fields`
 * and the URL sweep), widened by Foundry's own field-name heuristic.
 */
function configFloorSecrets(data: unknown): string[] {
  if (typeof data === "string") return urlSecrets(data);
  if (Array.isArray(data)) return data.flatMap(configFloorSecrets);
  if (data && typeof data === "object") {
    return Object.entries(data).flatMap(([field, value]) => {
      if (isSecretField(field) || isEdgeSensitiveConfigKey(field)) return submittedValues(value);
      if (normalizeConfigKey(field) === "redisurl") return projectedSecrets(value, "redis");
      return configFloorSecrets(value);
    });
  }
  return [];
}

/**
 * The secrets a plugin `config` carries, as Ferrum Edge's projection decides
 * them for a non-admin read (`project_plugin_config`): the plugin's schema
 * rules, then the name floor and URL sweep. A config that is not an object,
 * or belongs to a plugin with no known schema, is secret throughout.
 */
export function pluginConfigSecrets(pluginName: string, config: unknown): string[] {
  if (config === null || config === undefined) return [];
  const rules = PLUGIN_SENSITIVITY.get(pluginName);
  if (!rules || typeof config !== "object" || Array.isArray(config)) {
    return submittedValues(config);
  }
  return [...new Set([
    ...rules.flatMap((rule) => ruleSecrets(config, rule.path, rule.sensitivity)),
    ...configFloorSecrets(config),
  ])];
}

/**
 * The secrets a structured write payload carries, found by position rather
 * than by type of write: every string under a credential-shaped field name,
 * at any depth, and the credential-bearing parts of any URL elsewhere. Fails
 * closed on a whole subtree — `credentials`, `headers`, a `*_secret` object —
 * rather than trying to recognise which of its leaves is sensitive. A plugin
 * configuration (`plugin_name` beside `config`) at any depth — a plugin write,
 * or one entry of a batch — has its `config` classified by
 * `pluginConfigSecrets`.
 */
export function secretValues(data: unknown): string[] {
  if (typeof data === "string") return urlSecrets(data);
  if (Array.isArray(data)) return data.flatMap(secretValues);
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const pluginName = record.plugin_name;
    if (typeof pluginName === "string" && "config" in record) {
      const { config, ...rest } = record;
      return [...pluginConfigSecrets(pluginName, config), ...secretValues(rest)];
    }
    return Object.entries(record).flatMap(([field, value]) =>
      isSecretField(field) ? submittedValues(value) : secretValues(value));
  }
  return [];
}

/**
 * A multi-line value's lines long enough to carry key material on their own:
 * a PEM body line is 64 characters, and a parser that rejects one quotes that
 * line rather than the document. A shorter line — the tail of a PEM body,
 * JSON punctuation — is too short to be distinctive and is covered where the
 * whole value is echoed.
 */
const MIN_SECRET_LINE = 16;

/**
 * A PEM armor line (`-----BEGIN CERTIFICATE-----`). It is the same fixed text
 * in every document of its type and carries no key material, and a parser's
 * error names it ("expected -----BEGIN PRIVATE KEY-----"), so it stays
 * readable; only the base64 body between the armor lines is redacted.
 */
const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

function secretLines(value: string): string[] {
  if (!/[\r\n]/.test(value)) return [];
  return value.split(/\r?\n|\r/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length >= MIN_SECRET_LINE && !PEM_ARMOR_LINE.test(trimmed);
  });
}

/**
 * Every form in which a submitted value can be echoed: raw, JSON-escaped, and
 * both again with surrounding whitespace trimmed — for the whole value and for
 * each substantial line of a multi-line one. Longest first, so a form is never
 * left partially exposed by a shorter one replaced inside it.
 */
export function redactionForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    const lines = secretLines(value).flatMap((line) => [line, line.trim()]);
    for (const candidate of [value, value.trim(), ...lines]) {
      if (!candidate) continue;
      forms.add(candidate);
      forms.add(JSON.stringify(candidate).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** `text` with every form of every submitted value replaced by `[REDACTED]`. */
export function redactSubmitted(text: string, forms: readonly string[]): string {
  let redacted = text;
  for (const form of forms) redacted = redacted.split(form).join(REDACTION_MARKER);
  return redacted;
}

/** A parsed error body with every string in it — keys included — redacted. */
export function redactBody(value: unknown, forms: readonly string[]): unknown {
  if (typeof value === "string") return redactSubmitted(value, forms);
  if (Array.isArray(value)) return value.map((item) => redactBody(item, forms));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redactSubmitted(key, forms), redactBody(item, forms)]));
  }
  return value;
}

/**
 * The gateway's detail for a rejected write, redacted before it is extracted.
 * Extraction trims and truncates each field, which would leave a long or
 * whitespace-padded secret no longer matching its submitted value, so
 * redaction must see the body exactly as the gateway sent it (#466).
 */
export async function redactedErrorDetail(
  error: Error,
  forms: readonly string[],
): Promise<string> {
  if ("data" in error) {
    const detail = extractApiErrorData(redactBody((error as { data?: unknown }).data, forms));
    if (detail) return redactSubmitted(detail, forms);
  }
  const response = "response" in error ? (error as { response?: Response }).response : undefined;
  if (!response) return "";
  try {
    const body = redactSubmitted(await response.clone().text(), forms);
    return redactSubmitted(extractApiErrorDetail(body), forms);
  } catch {
    return "";
  }
}

/**
 * A secret-bearing write the gateway refused, or whose answer never arrived.
 *
 * It keeps what callers decide on — the HTTP status and headers (`response`,
 * bodiless) and the parsed body (`data`) with every submitted secret replaced
 * by `[REDACTED]` — so `getApiErrorDetail`, `isPreconditionFailed` and the
 * outcome classifiers read it exactly as they read a ky `HTTPError`. It keeps
 * no `request`, no `options` and no `cause`: those hold the request body.
 * The committed-write and unobserved-write markers are carried over.
 */
export class RedactedWriteError extends Error {
  // Declared, not initialized: an absent status or body must not be an own
  // `undefined` property, which `"response" in error` checks would accept.
  declare readonly response?: Response;
  declare readonly data?: unknown;

  constructor(message: string, response: Response | undefined, data: unknown) {
    super(message);
    this.name = "RedactedWriteError";
    if (response) Object.defineProperty(this, "response", { value: response, enumerable: true });
    if (data !== undefined) Object.defineProperty(this, "data", { value: data, enumerable: true });
  }
}

function bodilessResponse(response: unknown): Response | undefined {
  if (!(response instanceof Response)) return undefined;
  try {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // A status `Response` cannot be constructed with carries no decision.
    return undefined;
  }
}

/**
 * `error` with every form of every value in `secrets` removed from its message
 * and body, as a `RedactedWriteError`. The body is redacted while it is still
 * whole — before any extraction trims or truncates it.
 */
export async function redactWriteFailure(
  error: unknown,
  secrets: readonly string[],
): Promise<RedactedWriteError> {
  const forms = redactionForms(secrets);
  const source = error instanceof Error
    ? (error as Error & { data?: unknown; response?: unknown })
    : undefined;
  let data: unknown;
  if (source && source.data !== undefined) {
    data = redactBody(source.data, forms);
  } else if (source?.response instanceof Response) {
    // A body ky did not parse is still unread on the response.
    try {
      const text = await source.response.clone().text();
      if (text) data = redactSubmitted(text, forms);
    } catch {
      // Already consumed — nothing further to recover.
    }
  }
  const redacted = new RedactedWriteError(
    source ? redactSubmitted(source.message, forms) : "Request failed",
    bodilessResponse(source?.response),
    data,
  );
  const committed = getCommittedWrite(error);
  if (committed) markCommittedWrite(redacted, committed);
  if (isUnobservedWrite(error)) markUnobservedWrite(redacted);
  return redacted;
}

/**
 * Run a secret-bearing write, replacing any failure with a
 * `RedactedWriteError` that no longer holds `secrets` or the request.
 *
 * Its request must carry `REDACT_ERRORS` (or `SILENT_ERRORS`, when the caller
 * reports every failure itself): the global error popup is raised from ky's
 * error, before this runs, and would show the raw body. `REDACT_ERRORS` holds
 * that report instead, and it is raised here with the submitted secrets
 * removed from its body — the same status, URL and unobserved outcome, so a
 * write whose answer was lost still opens the "Outcome unknown" dialog. A
 * failure the popup never reports (a committed write, a handled status) is
 * not held, so nothing is raised for it here either.
 */
export async function withRedactedFailure<T>(
  secrets: readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const held = takeHeldReport(error);
    const redacted = await redactWriteFailure(error, secrets);
    if (held) onApiError(redactReport(held, redacted, redactionForms(secrets)));
    throw redacted;
  }
}

/**
 * A held popup report with every submitted secret removed. The body is
 * rebuilt the way the client builds it (`beforeError` in `client.ts`) but
 * from the redacted error, whose body was redacted string by string: the
 * serialized raw body can hold an echo JSON-escaped twice (a field that is
 * itself JSON), which no redaction form matches. The unobserved outcome's
 * detail repeats the gateway's `error` string, so it is redacted too.
 */
function redactReport(
  report: ApiError,
  redacted: RedactedWriteError,
  forms: readonly string[],
): ApiError {
  const { outcome } = report;
  const data = report.statusCode === 0 ? redacted.message : redacted.data;
  const body = typeof data === "string" ? data : data === undefined ? "" : JSON.stringify(data);
  return {
    ...report,
    body: redactSubmitted(body, forms),
    ...(outcome && {
      outcome: {
        ...outcome,
        detail: outcome.detail === null ? null : redactSubmitted(outcome.detail, forms),
      },
    }),
  };
}
