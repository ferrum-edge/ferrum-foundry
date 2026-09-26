/* ------------------------------------------------------------------ */
/*  Echoed secrets on every secret-bearing write (#478)               */
/* ------------------------------------------------------------------ */

/**
 * A gateway refusal can repeat the value it refused. Consumer create, plugin
 * configuration writes, upstream writes, TLS key material, and batch create
 * all send secrets, so each failure must reach the page with every submitted
 * secret replaced by `[REDACTED]` — before any trimming or truncation — must
 * raise the global popup (the "Outcome unknown" dialog included) only with its
 * body redacted the same way, and must not keep the request, its options, or a
 * `cause`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ConsumerCreate, PluginConfigCreate, UpstreamCreate } from "./types";
import {
  getApiErrorDetail,
  getApiErrorMessage,
  getCommittedWrite,
  isUnobservedWrite,
  setApiErrorHandler,
} from "./client";
import { isPreconditionFailed } from "./conditionalWrite";
import { resetGatewayMetadata, setApplyStatusFetcher } from "./gatewayMetadata";
import { classifyUnobservedOutcome, MutationOutcomeUnknownError } from "./mutationOutcome";
import * as apiSpecs from "./apiSpecs";
import * as consumers from "./consumers";
import * as ops from "./ops";
import * as plugins from "./plugins";
import * as tls from "./tls";
import * as upstreams from "./upstreams";
import {
  pluginConfigSecrets,
  redactionForms,
  RedactedWriteError,
  secretValues,
  type Secrets,
  yamlScalars,
} from "./secretRedaction";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

const scope = { namespace: "tenant-a" };

// Deterministic but non-repeating, so any fragment of it is distinctive.
const LONG = Array.from({ length: 1000 }, (_, i) => ((i * 2654435761) % 36).toString(36)).join("");
const QUOTED = 'synthetic "quoted" \\ backslash secret 0123456789';
const PADDED = "   synthetic padded secret 0123456789abcdef   ";
const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7syntheticAAAA",
  "c3ludGhldGljLXByaXZhdGUta2V5LW1hdGVyaWFsLWZvci10ZXN0cy1vbmx5BBBB",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");
const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** Every form and every 32-character window of `value` that must not survive. */
function fragments(value: string): string[] {
  const found = [value.trim(), JSON.stringify(value.trim()).slice(1, -1)];
  for (let start = 0; start + 32 <= value.length; start += 16) {
    found.push(value.slice(start, start + 32));
  }
  return found;
}

/** Every place the failure could still carry the secret. */
async function exposure(error: unknown): Promise<string> {
  const record = error as Record<string, unknown>;
  return [
    (error as Error).message,
    await getApiErrorMessage(error, "fallback"),
    await getApiErrorDetail(error),
    JSON.stringify(record.data ?? null),
  ].join("\n");
}

function expectRedacted(text: string, secret: string): void {
  expect(text).toContain("[REDACTED]");
  for (const fragment of fragments(secret)) expect(text).not.toContain(fragment);
}

/**
 * The one popup the failure raised: the gateway's status and the request's
 * URL, with no fragment of `secret` in its body or its outcome's detail.
 */
function expectRedactedReport(secret: string, statusCode: number, path: string): ApiError {
  expect(reported).toHaveLength(1);
  const [report] = reported;
  expect(report.statusCode).toBe(statusCode);
  expect(new URL(report.url).pathname).toBe(path);
  expectRedacted(`${report.body}\n${report.outcome?.detail ?? "[REDACTED]"}`, secret);
  // An echo inside a field that is itself JSON is escaped twice once the body
  // is serialized for the popup.
  const twice = JSON.stringify(JSON.stringify(secret.trim()).slice(1, -1)).slice(1, -1);
  expect(report.body).not.toContain(twice);
  return report;
}

/** Nothing on the error still references the request or the ky error. */
function expectDetached(error: unknown): void {
  expect(error).toBeInstanceOf(RedactedWriteError);
  expect(error).not.toHaveProperty("request");
  expect(error).not.toHaveProperty("options");
  expect((error as Error).cause).toBeUndefined();
}

const sent: { method: string; path: string; body: string }[] = [];
const reported: ApiError[] = [];
let respond: (request: Request, body: string) => Response;

beforeEach(() => {
  sent.length = 0;
  reported.length = 0;
  resetGatewayMetadata();
  setApiErrorHandler((error) => reported.push(error));
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const body = await request.text();
    sent.push({ method: request.method, path: new URL(request.url).pathname, body });
    return respond(request, body);
  }));
});

afterEach(() => {
  setApiErrorHandler(undefined);
  resetGatewayMetadata();
  vi.unstubAllGlobals();
});

/** A gateway that repeats `secret` raw, JSON-escaped, and as a whole field. */
function echo(secret: string, status = 400) {
  respond = () => Response.json({
    error: `rejected ${secret}`,
    code: secret,
    details: JSON.stringify({ value: secret }),
    [secret]: "echoed as a key",
  }, { status });
}

function consumerWith(key: string): ConsumerCreate {
  return { username: "alice", credentials: { keyauth: [{ key }] } };
}

function pluginWith(secret: string): PluginConfigCreate {
  return {
    plugin_name: "http_logging",
    scope: "global",
    config: { endpoint_url: "http://collector.internal", auth: { client_secret: secret } },
  };
}

/** A classification with nothing left unclassified, as a sorted list. */
function classifiedValues(secrets: Secrets): string[] {
  expect(secrets.tokens).toEqual([]);
  return [...secrets.values].sort();
}

describe("secretValues", () => {
  it("takes every string under a credential-shaped field, at any depth, and nothing else", () => {
    expect(classifiedValues(secretValues({
      username: "alice",
      acl_groups: ["admins"],
      credentials: { keyauth: [{ key: "k-1" }], hmac_auth: [{ secret: "h-1" }] },
      config: {
        header_name: "x-api-key",
        client_secret: "cs-1",
        providers: [{ issuer: "https://idp.internal", clientSecret: "cs-2" }],
        headers: { "x-honeycomb-team": "hc-1" },
        accessKey: "ak-1",
        webhook_url: "https://hooks.internal/T0/B0",
      },
    }))).toEqual(["ak-1", "cs-1", "cs-2", "h-1", "hc-1", "https://hooks.internal/T0/B0",
      "k-1"].sort());
  });

  it("takes the credential-bearing parts of a URL anywhere, but not a bare origin", () => {
    expect(classifiedValues(secretValues({ endpoint: "https://collector.internal:4318" })))
      .toEqual([]);
    expect(classifiedValues(secretValues({ endpoint: "https://collector.internal/" }))).toEqual([]);
    expect(classifiedValues(secretValues({ redis_url: "redis://user:pa55@cache.internal:6379/0" })))
      .toEqual(["redis://user:pa55@cache.internal:6379/0", "user:pa55", "/0"].sort());
    expect(classifiedValues(secretValues({ endpoint: "https://logs.internal/v1/push/t0ken?code=c0de" })))
      .toEqual(["https://logs.internal/v1/push/t0ken?code=c0de", "/v1/push/t0ken?code=c0de"].sort());
  });

  it("does not treat a path to key material as the material", () => {
    expect(classifiedValues(secretValues({ backend_tls_client_key_path: "/etc/ferrum/client.key" })))
      .toEqual([]);
  });

  it("redacts each substantial line of a multi-line value, but not the PEM armor", () => {
    const forms = redactionForms([PEM]).substrings;
    expect(forms).toContain(PEM.split("\n")[1]);
    expect(forms).toContain(PEM.split("\n")[2]);
    expect(forms).not.toContain("");
    expect(forms).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(forms).not.toContain("-----END PRIVATE KEY-----");
    expect(redactionForms([CERT]).substrings).not.toContain("-----BEGIN CERTIFICATE-----");
  });
});

describe("plugin configurations follow Ferrum Edge's projection", () => {
  it.each([
    ["ai_semantic_cache", { semantic_embedding_auth_header: "Api-Key emb-1" }, ["Api-Key emb-1"]],
    ["proxy_alerts", {
      channels: [{ type: "webhook", url: "https://alerts.internal", body_template: "{\"rk\":\"rk-1\"}" }],
    }, ['{"rk":"rk-1"}']],
    ["proxy_alerts", {
      channels: { pager: { url: "https://alerts.internal", body_template: "rk-2" } },
    }, ["rk-2"]],
    ["api_chargeback_sink", {
      clickhouse: { url: "https://ch.internal:8443", insert_query_params: { quota_hint: "q-1" } },
    }, ["q-1"]],
    ["otel_tracing", { headers: { "x-honeycomb-team": "hc-1" }, service_name: "edge" }, ["hc-1"]],
    ["serverless_function", { azure_function_key: "fk-1", provider: "azure" }, ["fk-1"]],
    ["loki_logging", { authorization_header: "Basic b64-1", batch_size: "100" }, ["Basic b64-1"]],
  ])("%s: takes the paths Edge redacts and nothing else", (plugin, config, expected) => {
    expect(classifiedValues(pluginConfigSecrets(plugin, config))).toEqual([...expected].sort());
  });

  it("takes every kafka producer property off Edge's safe list, a PEM key included", () => {
    const secrets = secretValues({
      plugin_name: "kafka_logging",
      config: {
        broker_list: "kafka.internal:9092",
        topic: "edge-logs",
        producer_config: {
          "ssl.key.pem": PEM,
          "sasl.oauthbearer.config": "principal=edge secret=s-1",
          acks: "all",
          "compression.type": "zstd",
        },
      },
    });
    expect(classifiedValues(secrets)).toEqual([PEM, "principal=edge secret=s-1"].sort());
    const forms = redactionForms(secrets).substrings;
    expect(forms).toContain(PEM.split("\n")[1]);
    expect(forms).not.toContain("all");
    expect(forms).not.toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("fails closed where Edge does: a scalar where a map is expected, a non-URL endpoint", () => {
    expect(classifiedValues(pluginConfigSecrets("kafka_logging", { producer_config: "ssl.key.pem=pk-1" })))
      .toEqual(["ssl.key.pem=pk-1"]);
    expect(classifiedValues(pluginConfigSecrets("opa", { headers: "Bearer opa-1" })))
      .toEqual(["Bearer opa-1"]);
    expect(classifiedValues(pluginConfigSecrets("http_logging", { endpoint_url: "collector.internal/t0ken" })))
      .toEqual(["collector.internal/t0ken"]);
    expect(classifiedValues(pluginConfigSecrets("http_logging", { endpoint_url: "https://collector.internal" })))
      .toEqual([]);
  });

  it("matches Edge's normalized key spellings and its name floor", () => {
    expect(classifiedValues(pluginConfigSecrets("http_logging", { customHeaders: { "X-Tenant": "t-1" } })))
      .toEqual(["t-1"]);
    expect(classifiedValues(pluginConfigSecrets("http_logging", {
      nested: { "private.key": "pk-2", APIKey: "ak-2" },
    }))).toEqual(["ak-2", "pk-2"]);
  });

  it("treats every string of a plugin with no known schema as secret, short ones as whole tokens", () => {
    const secrets = pluginConfigSecrets("acme_custom_auth", {
      mode: "strict",
      upstream: { realm: "r-1", callback: "https://idp.internal/cb?state=s-1" },
      tags: ["t-2", "a longer unclassified value"],
      client_secret: "c",
    });
    // Edge's name floor and URL sweep still classify what they recognize.
    expect(new Set(secrets.values)).toEqual(new Set([
      "a longer unclassified value",
      "c",
      "https://idp.internal/cb?state=s-1",
      "/cb?state=s-1",
    ]));
    expect([...secrets.tokens].sort()).toEqual(["c", "r-1", "strict", "t-2"]);
    // A short value that is also classified is matched wherever it occurs.
    expect(redactionForms(secrets).tokens).not.toContain("c");
    expect(classifiedValues(pluginConfigSecrets("rate_limiting", ["not", "an object"])))
      .toEqual(["an object", "not"]);
  });
});

describe("consumer create (#478)", () => {
  it.each([
    ["a 1000-character key", LONG],
    ["a key that needs JSON escapes", QUOTED],
    ["a whitespace-padded key", PADDED],
  ])("keeps no fragment of %s the gateway echoed, in the error or the popup", async (_, secret) => {
    // `details` holds the secret JSON-escaped once; the popup's serialized
    // body would escape it again, so the popup must be built from the
    // redacted body rather than by redacting the serialized one.
    echo(secret);
    const failure = await consumers.create(scope, consumerWith(secret)).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), secret);
    // The status still reaches the page, and the username is not a secret.
    expect((failure as RedactedWriteError).response?.status).toBe(400);
    expect(expectRedactedReport(secret, 400, "/api/proxy/consumers").outcome).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).credentials.keyauth[0].key).toBe(secret);
  });

  it("keeps the committed-but-not-live marker, without the popup", async () => {
    setApplyStatusFetcher(() => new Promise(() => {}));
    respond = () => Response.json(
      { error: `reload timed out after ${LONG}`, applied: false, reason: "reload_timeout" },
      { status: 503, headers: { "x-ferrum-config-cursor": "1:2" } },
    );
    const failure = await consumers.create(scope, consumerWith(LONG)).catch((e: unknown) => e);

    expectDetached(failure);
    expect(getCommittedWrite(failure)).toEqual({ cursor: "1:2", reason: "reload_timeout" });
    expect(await getApiErrorMessage(failure, "Failed")).toContain("committed, not yet proven live");
    expectRedacted(JSON.stringify((failure as RedactedWriteError).data), LONG);
    expect(reported).toEqual([]);
  });

  it("keeps the unobserved-write marker, and opens the redacted Outcome unknown dialog", async () => {
    respond = () => Response.json(
      { error: `Bad Gateway ${LONG}`, code: "FERRUM_BFF_UPSTREAM_FAILURE" },
      { status: 502 },
    );
    const failure = await consumers.create(scope, consumerWith(LONG)).catch((e: unknown) => e);

    expectDetached(failure);
    expect(isUnobservedWrite(failure)).toBe(true);
    expect(await getApiErrorMessage(failure, "Failed")).toContain("Outcome unknown");
    expectRedacted(await exposure(failure), LONG);
    // The dialog keeps what diagnosis needs — the outcome, the status, the URL,
    // and the BFF's code — and nothing that was submitted.
    const report = expectRedactedReport(LONG, 502, "/api/proxy/consumers");
    expect(report.outcome).toEqual({ reason: "upstream_failure", detail: "Bad Gateway [REDACTED]" });
    expect(report.body).toContain("FERRUM_BFF_UPSTREAM_FAILURE");
    expect(sent).toHaveLength(1);
  });

  it("reports a transport failure as an unknown outcome, without replaying it", async () => {
    respond = () => { throw new TypeError("Failed to fetch"); };
    const failure = await consumers.create(scope, consumerWith(LONG)).catch((e: unknown) => e);

    expectDetached(failure);
    expect(isUnobservedWrite(failure)).toBe(true);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ statusCode: 0, outcome: { reason: "transport" } });
    expect(new URL(reported[0].url).pathname).toBe("/api/proxy/consumers");
    for (const fragment of fragments(LONG)) expect(JSON.stringify(reported[0])).not.toContain(fragment);
    expect(sent).toHaveLength(1);
  });
});

describe("plugin configuration writes (#478)", () => {
  it.each([
    ["a 1000-character client secret", LONG],
    ["a client secret that needs JSON escapes", QUOTED],
    ["a whitespace-padded client secret", PADDED],
  ])("create keeps no fragment of %s, in the error or the popup", async (_, secret) => {
    echo(secret);
    const failure = await plugins.createConfig(scope, pluginWith(secret)).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), secret);
    expectRedactedReport(secret, 400, "/api/proxy/plugins/config");
  });

  it("create keeps no line of a kafka producer's PEM key", async () => {
    const line = PEM.split("\n")[1];
    respond = () => Response.json(
      { error: `producer_config: ssl.key.pem: bad base64 in ${line}` },
      { status: 400 },
    );
    const failure = await plugins.createConfig(scope, {
      plugin_name: "kafka_logging",
      scope: "global",
      config: { broker_list: "kafka.internal:9092", producer_config: { "ssl.key.pem": PEM } },
    }).catch((e: unknown) => e);

    expectDetached(failure);
    const text = await exposure(failure);
    expect(text).toContain("ssl.key.pem: bad base64 in [REDACTED]");
    expect(text).not.toContain(line);
    expect(reported).toHaveLength(1);
    expect(reported[0].body).not.toContain(line);
  });

  it("update keeps no fragment of a secret in a URL, and a 412 stays a precondition failure", async () => {
    const url = `https://ops:${LONG}@collector.internal/v1/push`;
    const plugin = { ...pluginWith("unused"), config: { endpoint_url: url } };
    echo(url);
    const failure = await plugins.updateConfig(scope, "log", plugin, '"r1"').catch((e: unknown) => e);
    expectDetached(failure);
    expectRedacted(await exposure(failure), url);
    expect(isPreconditionFailed(failure)).toBe(false);
    expectRedactedReport(url, 400, "/api/proxy/plugins/config/log");

    // A handled 412 is the guard's to resolve: no popup for it.
    reported.length = 0;
    respond = () => Response.json({ error: `precondition failed for ${url}` }, { status: 412 });
    const refused = await plugins.updateConfig(scope, "log", plugin, '"r1"').catch((e: unknown) => e);
    expectDetached(refused);
    expect(isPreconditionFailed(refused)).toBe(true);
    expect(sent.at(-1)?.method).toBe("PUT");
    expect(reported).toEqual([]);
  });
});

describe("upstream writes (#478)", () => {
  const upstream = (token: string): UpstreamCreate => ({
    name: "orders",
    algorithm: "round_robin",
    targets: [],
    service_discovery: {
      provider: "consul",
      consul: { address: "http://consul.internal:8500", service_name: "orders", token },
    },
  } as UpstreamCreate);

  it("create and unguarded update keep no fragment of the Consul token", async () => {
    echo(PADDED);
    const created = await upstreams.create(scope, upstream(PADDED)).catch((e: unknown) => e);
    expectDetached(created);
    expectRedacted(await exposure(created), PADDED);
    expectRedactedReport(PADDED, 400, "/api/proxy/upstreams");

    reported.length = 0;
    echo(LONG);
    const updated = await upstreams.update(scope, "orders", upstream(LONG), null)
      .catch((e: unknown) => e);
    expectDetached(updated);
    expectRedacted(await exposure(updated), LONG);
    expectRedactedReport(LONG, 400, "/api/proxy/upstreams/orders");
  });
});

describe("TLS key material and ACME credentials (#478)", () => {
  it("managed certificate create keeps no line of the private key the gateway quoted", async () => {
    const line = PEM.split("\n")[2];
    respond = () => Response.json({ error: `key_pem: invalid base64 in line ${line}` }, { status: 400 });
    const failure = await tls.createManagedRecord("certificates", {
      cert_pem: CERT,
      key_pem: PEM,
    }).catch((e: unknown) => e);

    expectDetached(failure);
    const text = await exposure(failure);
    expect(text).toContain("key_pem: invalid base64 in line [REDACTED]");
    expect(text).not.toContain(line);
    // The form renders this refusal under the field itself.
    expect(reported).toEqual([]);
  });

  it("keeps a PEM armor line the gateway names readable", async () => {
    respond = () => Response.json(
      { error: "key_pem: expected -----BEGIN PRIVATE KEY-----" },
      { status: 400 },
    );
    const failure = await tls.createManagedRecord("certificates", {
      cert_pem: CERT,
      key_pem: PEM,
    }).catch((e: unknown) => e);

    expect(await getApiErrorDetail(failure)).toBe("key_pem: expected -----BEGIN PRIVATE KEY-----");
  });

  it.each([
    ["managed record update", "/api/proxy/admin/tls/certificates/edge", () =>
      tls.updateManagedRecord("certificates", "edge", { cert_pem: CERT, key_pem: LONG })],
    ["ACME certificate import", "/api/proxy/admin/tls/acme/certificates", () =>
      tls.createAcmeCertificate({ domains: ["a.example"], directory_url: "https://acme.example",
        cert_pem: CERT, key_pem: LONG })],
    ["ACME certificate replacement", "/api/proxy/admin/tls/acme/certificates/edge", () =>
      tls.updateAcmeCertificate("edge", { domains: ["a.example"], directory_url: "https://acme.example",
        cert_pem: CERT, key_pem: LONG })],
  ])("%s keeps no fragment of the key in the error or the popup", async (_, path, write) => {
    echo(LONG);
    const failure = await write().catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), LONG);
    expectRedactedReport(LONG, 400, path);
  });

  it("validation keeps no fragment of the key and leaves the refusal to its form", async () => {
    echo(LONG);
    const failure = await tls.validateMaterial({ key_pem: LONG }).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), LONG);
    expect(reported).toEqual([]);
  });

  it("an ACME order keeps the account credentials out of an unknown outcome's cause", async () => {
    respond = () => Response.json({ error: `upstream said ${QUOTED}` }, { status: 500 });
    const failure = await tls.createAcmeOrder({
      domains: ["a.example"],
      directory_url: "https://acme.example",
      existing_account_credentials_json: QUOTED,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(MutationOutcomeUnknownError);
    const cause = (failure as Error).cause;
    expectDetached(cause);
    expectRedacted(await exposure(cause), QUOTED);
    expect(reported).toEqual([]);
  });
});

describe("batch create (#478)", () => {
  it("keeps no fragment of a consumer's credential or a plugin secret", async () => {
    echo(QUOTED);
    const failure = await ops.batchCreate(scope, {
      consumers: [consumerWith(QUOTED)],
      plugin_configs: [pluginWith(QUOTED)],
    }).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), QUOTED);
    expectRedactedReport(QUOTED, 400, "/api/proxy/batch");
  });
});

describe("short unclassified values (#487)", () => {
  it("are redacted only as whole tokens, never in a key, and never split a marker", async () => {
    respond = () => Response.json({
      error: "error: mode error rejected; toggle on is not a configuration option",
      code: "FERRUM_PLUGIN_INVALID",
      details: "level a, retries 1",
    }, { status: 400 });
    // A plugin with no known schema: every string of its config is secret.
    const failure = await plugins.createConfig(scope, {
      plugin_name: "acme_custom",
      scope: "global",
      config: { mode: "error", level: "a", retries: "1", toggle: "on", marker: "E" },
    }).catch((e: unknown) => e);

    expectDetached(failure);
    const data = (failure as RedactedWriteError).data as Record<string, string>;
    expect(data).toEqual({
      error: "[REDACTED]: mode [REDACTED] rejected; toggle [REDACTED] is not [REDACTED] configuration option",
      code: "FERRUM_PLUGIN_INVALID",
      details: "level [REDACTED], retries [REDACTED]",
    });
    expect(await getApiErrorDetail(failure))
      .toBe(`${data.error}\nFERRUM_PLUGIN_INVALID: level [REDACTED], retries [REDACTED]`);
    expect(reported).toHaveLength(1);
    expect(JSON.parse(reported[0].body)).toEqual(data);
  });

  it("are still redacted wherever they occur when a long unclassified value is echoed", async () => {
    echo(LONG);
    const failure = await plugins.createConfig(scope, {
      plugin_name: "acme_custom",
      scope: "global",
      config: { blob: LONG },
    }).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), LONG);
    expectRedactedReport(LONG, 400, "/api/proxy/plugins/config");
  });
});

describe("backup restore (#485)", () => {
  const BLOB = "H4sIAAAAAAAA/6tWSs7PS8tMVbJSMDI2MTZRqgUAKmHVExgAAAA=synthetic-spec-document";
  const backup = (key: string) => ({
    version: "1",
    consumers: [{ id: "alice", username: "alice", credentials: { keyauth: [{ key }] } }],
    plugin_configs: [
      { id: "p1", plugin_name: "acme_custom", scope: "global", config: { mode: "error" } },
    ],
    api_specs: {
      section_version: "2",
      items: [{ id: "spec-1", proxy_id: "orders", spec_content_base64: BLOB }],
    },
  });

  it("keeps no fragment of a credential or a spec document, and the recovery details readable", async () => {
    respond = () => Response.json({
      error: `restore import failed for key ${LONG}`,
      rollback: "completed",
      restore_errors: [
        `consumer alice: duplicate key ${LONG}`,
        `api_spec 'spec-1': bad content ${BLOB}`,
        "plugin p1: mode error",
      ],
    }, { status: 500 });
    const failure = await ops.restore(scope, backup(LONG)).catch((e: unknown) => e);

    expectDetached(failure);
    const text = await exposure(failure);
    expectRedacted(text, LONG);
    expect(text).not.toContain(BLOB);
    expect(ops.getRestoreFailure(failure)).toEqual({
      error: "restore import failed for key [REDACTED]",
      rollback: "completed",
      restore_errors: [
        "consumer alice: duplicate key [REDACTED]",
        "api_spec 'spec-1': bad content [REDACTED]",
        "plugin p1: mode [REDACTED]",
      ],
    });
    // The card reports every restore failure itself.
    expect(reported).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).consumers[0].credentials.keyauth[0].key).toBe(LONG);
  });

  it("still recognizes the API spec deletion confirmation and an unobserved outcome", async () => {
    respond = () => Response.json({
      error: "restore would delete API specs",
      api_specs_at_risk: 2,
      confirmation_required: "confirm_api_spec_deletion=true",
    }, { status: 409 });
    const conflict = await ops.restore(scope, backup(LONG)).catch((e: unknown) => e);
    expectDetached(conflict);
    expect(ops.getRestoreApiSpecConfirmation(conflict)).toEqual({
      error: "restore would delete API specs",
      api_specs_at_risk: 2,
      confirmation_required: "confirm_api_spec_deletion=true",
    });

    respond = () => { throw new TypeError("Failed to fetch"); };
    const lost = await ops.restore(scope, backup(LONG)).catch((e: unknown) => e);
    expectDetached(lost);
    expect(classifyUnobservedOutcome(lost)?.reason).toBe("transport");
    expect(reported).toEqual([]);
  });
});

describe("API spec import and replacement (#485)", () => {
  const collector = `https://ops:${LONG}@collector.internal/v1/push`;
  const json = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1" },
    "x-ferrum-proxy": { name: "orders", listen_path: "/orders" },
    "x-ferrum-plugins": [
      {
        plugin_name: "http_logging",
        config: { endpoint_url: collector, custom_headers: { "X-Tenant": QUOTED } },
      },
      { plugin_name: "acme_custom", config: { mode: "error", seed: PADDED } },
      "not a plugin configuration 0123456789",
    ],
  });

  it("classifies a JSON document by position: secrets redacted, the rest readable", async () => {
    respond = () => Response.json({
      error: "Validation failed",
      failures: [
        { resource_type: "plugin_config", id: "p1", errors: [`header X-Tenant ${QUOTED}`, `endpoint ${collector}`] },
        {
          resource_type: "plugin_config",
          id: "p2",
          errors: [`seed ${PADDED.trim()}`, "mode error", "entry not a plugin configuration 0123456789"],
        },
        { resource_type: "proxy", id: "orders", errors: ["Proxy name 'orders' already exists"] },
      ],
    }, { status: 400 });
    const failure = await apiSpecs.create(scope, json).catch((e: unknown) => e);

    expectDetached(failure);
    const text = await exposure(failure);
    for (const secret of [QUOTED, collector, PADDED]) expectRedacted(text, secret);
    expect(await getApiErrorDetail(failure)).toBe([
      "Validation failed",
      "plugin_config (p1): header X-Tenant [REDACTED]",
      "plugin_config (p1): endpoint [REDACTED]",
      "plugin_config (p2): seed [REDACTED]",
      "plugin_config (p2): mode [REDACTED]",
      "plugin_config (p2): entry [REDACTED]",
      "proxy (orders): Proxy name 'orders' already exists",
    ].join("\n"));
    expect(reported).toEqual([]);
    expect(sent[0].body).toBe(json);
  });

  it("treats every scalar of a YAML document as secret and keeps the gateway's keys", async () => {
    const yaml = [
      "openapi: 3.1.0",
      "x-ferrum-plugins:",
      "  - plugin_name: acme_custom",
      "    config:",
      "      mode: error",
      '      api_secret: "sk-live-\\u0041BC\\"xyz"',
      "      region: 'eu west'",
      "      note: >-",
      "        folded secret part one",
      "        folded secret part two",
      '      flags: [on, "tight, spaced"]',
      "",
    ].join("\n");
    respond = () => Response.json({
      error: "Spec parse failed",
      code: "invalid_plugin",
      details: "x-ferrum-plugins[0]: api_secret sk-live-ABC\"xyz rejected; note folded secret part " +
        "one folded secret part two; flag tight, spaced; region eu west; mode error",
    }, { status: 400 });
    const failure = await apiSpecs.update(scope, "orders-spec", yaml).catch((e: unknown) => e);

    expectDetached(failure);
    expect(Object.keys((failure as RedactedWriteError).data as object))
      .toEqual(["error", "code", "details"]);
    expect(await getApiErrorDetail(failure)).toBe(
      "invalid_plugin: x-ferrum-plugins[0]: api_secret [REDACTED] rejected; note [REDACTED] " +
        "[REDACTED]; flag [REDACTED]; region [REDACTED]; mode [REDACTED]",
    );
    expect(reported).toEqual([]);
  });

  it("keeps the document out of an unknown outcome's cause", async () => {
    respond = () => Response.json({ error: `upstream said ${QUOTED}` }, { status: 503 });
    const failure = await apiSpecs.create(scope, json).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(MutationOutcomeUnknownError);
    const cause = (failure as Error).cause;
    expectDetached(cause);
    expectRedacted(await exposure(cause), QUOTED);
    expect(reported).toEqual([]);
  });

  it("finds YAML scalars without a parser, but not a line that is only a key", () => {
    const scalars = yamlScalars([
      "x-ferrum-plugins:",
      "  - &cfg !!str 'it''s'",
      '  - "a\\x41"',
      "  - {token: t0ken-value, nested: [x, 'y, z']}",
    ].join("\n"));
    expect(scalars).not.toContain("x-ferrum-plugins:");
    expect(scalars).toEqual(expect.arrayContaining(["it's", "aA", "t0ken-value", "x", "y, z"]));
  });
});
