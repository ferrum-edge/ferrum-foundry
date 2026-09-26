/* ------------------------------------------------------------------ */
/*  Echoed secrets on every secret-bearing write (#478)               */
/* ------------------------------------------------------------------ */

/**
 * A gateway refusal can repeat the value it refused. Consumer create, plugin
 * configuration writes, upstream writes, TLS key material, and batch create
 * all send secrets, so each failure must reach the page with every submitted
 * secret replaced by `[REDACTED]` — before any trimming or truncation — must
 * not raise the global popup (which shows the raw body), and must not keep the
 * request, its options, or a `cause`.
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
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import * as consumers from "./consumers";
import * as ops from "./ops";
import * as plugins from "./plugins";
import * as tls from "./tls";
import * as upstreams from "./upstreams";
import {
  redactionForms,
  RedactedWriteError,
  secretValues,
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

describe("secretValues", () => {
  it("takes every string under a credential-shaped field, at any depth, and nothing else", () => {
    expect(secretValues({
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
    }).sort()).toEqual(["ak-1", "cs-1", "cs-2", "h-1", "hc-1", "https://hooks.internal/T0/B0",
      "k-1"].sort());
  });

  it("takes the credential-bearing parts of a URL anywhere, but not a bare origin", () => {
    expect(secretValues({ endpoint: "https://collector.internal:4318" })).toEqual([]);
    expect(secretValues({ endpoint: "https://collector.internal/" })).toEqual([]);
    expect(secretValues({ redis_url: "redis://user:pa55@cache.internal:6379/0" }))
      .toEqual(["redis://user:pa55@cache.internal:6379/0", "user:pa55", "/0"]);
    expect(secretValues({ endpoint: "https://logs.internal/v1/push/t0ken?code=c0de" }))
      .toEqual(["https://logs.internal/v1/push/t0ken?code=c0de", "/v1/push/t0ken?code=c0de"]);
  });

  it("does not treat a path to key material as the material", () => {
    expect(secretValues({ backend_tls_client_key_path: "/etc/ferrum/client.key" })).toEqual([]);
  });

  it("redacts each substantial line of a multi-line value", () => {
    const forms = redactionForms([PEM]);
    expect(forms).toContain(PEM.split("\n")[1]);
    expect(forms).toContain(PEM.split("\n")[2]);
    expect(forms).not.toContain("");
  });
});

describe("consumer create (#478)", () => {
  it.each([
    ["a 1000-character key", LONG],
    ["a key that needs JSON escapes", QUOTED],
    ["a whitespace-padded key", PADDED],
  ])("keeps no fragment of %s the gateway echoed, and raises no popup", async (_, secret) => {
    echo(secret);
    const failure = await consumers.create(scope, consumerWith(secret)).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), secret);
    // The status still reaches the page, and the username is not a secret.
    expect((failure as RedactedWriteError).response?.status).toBe(400);
    expect(reported).toEqual([]);
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

  it("keeps the unobserved-write marker, without the popup", async () => {
    respond = () => Response.json(
      { error: `Bad Gateway ${LONG}`, code: "FERRUM_BFF_UPSTREAM_FAILURE" },
      { status: 502 },
    );
    const failure = await consumers.create(scope, consumerWith(LONG)).catch((e: unknown) => e);

    expectDetached(failure);
    expect(isUnobservedWrite(failure)).toBe(true);
    expect(await getApiErrorMessage(failure, "Failed")).toContain("Outcome unknown");
    expectRedacted(await exposure(failure), LONG);
    expect(reported).toEqual([]);
  });
});

describe("plugin configuration writes (#478)", () => {
  it.each([
    ["a 1000-character client secret", LONG],
    ["a client secret that needs JSON escapes", QUOTED],
    ["a whitespace-padded client secret", PADDED],
  ])("create keeps no fragment of %s", async (_, secret) => {
    echo(secret);
    const failure = await plugins.createConfig(scope, pluginWith(secret)).catch((e: unknown) => e);

    expectDetached(failure);
    expectRedacted(await exposure(failure), secret);
    expect(reported).toEqual([]);
  });

  it("update keeps no fragment of a secret in a URL, and a 412 stays a precondition failure", async () => {
    const url = `https://ops:${LONG}@collector.internal/v1/push`;
    const plugin = { ...pluginWith("unused"), config: { endpoint_url: url } };
    echo(url);
    const failure = await plugins.updateConfig(scope, "log", plugin, '"r1"').catch((e: unknown) => e);
    expectDetached(failure);
    expectRedacted(await exposure(failure), url);
    expect(isPreconditionFailed(failure)).toBe(false);

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

    echo(LONG);
    const updated = await upstreams.update(scope, "orders", upstream(LONG), null)
      .catch((e: unknown) => e);
    expectDetached(updated);
    expectRedacted(await exposure(updated), LONG);
    expect(reported).toEqual([]);
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
    expect(reported).toEqual([]);
  });

  it.each([
    ["managed record update", () =>
      tls.updateManagedRecord("certificates", "edge", { cert_pem: CERT, key_pem: LONG })],
    ["ACME certificate import", () =>
      tls.createAcmeCertificate({ domains: ["a.example"], directory_url: "https://acme.example",
        cert_pem: CERT, key_pem: LONG })],
    ["ACME certificate replacement", () =>
      tls.updateAcmeCertificate("edge", { domains: ["a.example"], directory_url: "https://acme.example",
        cert_pem: CERT, key_pem: LONG })],
    ["validation", () => tls.validateMaterial({ key_pem: LONG })],
  ])("%s keeps no fragment of the key and raises no popup", async (_, write) => {
    echo(LONG);
    const failure = await write().catch((e: unknown) => e);

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
    expect(reported).toEqual([]);
  });
});
