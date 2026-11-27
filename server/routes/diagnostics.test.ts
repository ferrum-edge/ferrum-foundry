import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BEARER_PATTERN = /^Bearer /;

const upstream = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: upstream,
}));

// Synthetic test inputs, never deployment credentials.
const loginToken = "diagnostics-route-development-fixture-long";
const REF = `fd1_${"3f9c2a7e5b1d4c8a".repeat(2)}`;
const lookup = {
  schema_version: "ferrum.diagnostic_ref.v1",
  ref: REF,
  namespace: "tenant-a",
  created_at: "2026-09-27T10:15:02.114Z",
  expires_at: "2026-09-27T10:30:02.114Z",
  protocol: "http2",
  status: 502,
  gateway_error: "connection_failure",
  detail_available: true,
  detail: {
    error_class: "dns_lookup_error",
    body_error_class: null,
    rejection_phase: null,
    route_timeout_phase: null,
    backend_dispatch: "pre_wire_failure",
    proxy_id: "orders-api",
    backend_target: "https://user:secret@orders.internal:8443/private/path?token=abc",
    duration_bucket: "lt_100ms",
    attempts: [{ attempt: 1, backend_dispatch: "pre_wire_failure", error_class: "dns_lookup_error" }],
  },
};

let app: FastifyInstance | undefined;
let headers: Record<string, string>;

function stubEnvironment(extra: Record<string, string> = {}) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FERRUM_")) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    FERRUM_ADMIN_URL: "https://gateway.example.test",
    FERRUM_AUTH_MODE: "static",
    FERRUM_JWT_SECRET: "diagnostics-route-signing-fixture-long",
    FERRUM_BFF_AUTH_TOKEN: loginToken,
    FERRUM_JWT_NAMESPACES: "*",
    FERRUM_SECURE_COOKIES: "false",
    ...extra,
  })) vi.stubEnv(key, value);
}

beforeEach(() => {
  vi.resetModules();
  upstream.mockReset();
  upstream.mockImplementation(async () => Response.json(lookup));
  stubEnvironment();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  const { closeDispatchers } = await import("../tls.js");
  await closeDispatchers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup(env: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { authPlugin } = await import("../auth.js");
  const { default: diagnosticsPlugin } = await import("./diagnostics.js");
  app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(diagnosticsPlugin);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { token: loginToken } });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "),
    "x-ferrum-namespace": "tenant-a",
  };
  return app;
}

function lookUp(server: FastifyInstance, url = `/api/diagnostics/refs/${REF}`, extra: Record<string, string> = {}) {
  return server.inject({ method: "GET", url, headers: { ...headers, ...extra } });
}

describe("diagnostic lookup permission", () => {
  it.each(["viewer", "operator", "admin"])("refuses the %s role by default and never signs or fetches", async (role) => {
    const server = await setup({ FERRUM_JWT_ROLE: role });
    const config = await server.inject({ method: "GET", url: "/api/diagnostics/config", headers });
    expect(config.json()).toEqual({ lookupPermitted: false });
    const response = await lookUp(server);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an admin that FERRUM_DIAGNOSTICS_ROLES does not list", async () => {
    const server = await setup({ FERRUM_JWT_ROLE: "admin", FERRUM_DIAGNOSTICS_ROLES: "viewer,operator" });
    expect((await server.inject({ method: "GET", url: "/api/diagnostics/config", headers })).json())
      .toEqual({ lookupPermitted: false });
    expect((await lookUp(server)).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const response = await server.inject({ method: "GET", url: `/api/diagnostics/refs/${REF}` });
    expect(response.statusCode).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an unknown role name at startup", async () => {
    stubEnvironment({ FERRUM_DIAGNOSTICS_ROLES: "admin,root" });
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow("FERRUM_DIAGNOSTICS_ROLES");
  });
});

describe("diagnostic lookup for a listed role", () => {
  it("signs a namespace-bound, scoped, short-lived token and returns the reviewed projection", async () => {
    const server = await setup({ FERRUM_JWT_ROLE: "viewer", FERRUM_DIAGNOSTICS_ROLES: "viewer" });
    expect((await server.inject({ method: "GET", url: "/api/diagnostics/config", headers })).json())
      .toEqual({ lookupPermitted: true });
    upstream.mockImplementation(async () => Response.json({ ...lookup, unreviewed: "dropped" }));
    const response = await lookUp(server);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).not.toHaveProperty("unreviewed");
    expect(body.detail.backend_target).toBe("https://orders.internal:8443");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.detail.attempts).toEqual(lookup.detail.attempts);

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [URL, { headers: Record<string, string>; redirect: string }];
    expect(url.toString()).toBe(`https://gateway.example.test/diagnostics/v1/refs/${REF}`);
    expect(init.redirect).toBe("error");
    expect(init.headers).not.toHaveProperty("x-ferrum-namespace");
    const claims = decodeJwt(init.headers.authorization.replace(BEARER_PATTERN, ""));
    expect(claims).toMatchObject({ role: "viewer", ns: "tenant-a", scope: "diagnostics:read" });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBeLessThanOrEqual(60);
  });

  it("never puts the scope on ordinary proxy tokens", async () => {
    stubEnvironment({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const { generateToken } = await import("../jwt.js");
    const { loadConfig } = await import("../config.js");
    const token = await generateToken(loadConfig(), {
      subject: "operator", displayName: "operator", role: "admin", namespaces: undefined, authMode: "static",
    });
    expect(decodeJwt(token)).not.toHaveProperty("scope");
  });

  it.each([
    ["an uppercase reference", `/api/diagnostics/refs/${REF.toUpperCase()}`],
    ["a short reference", "/api/diagnostics/refs/fd1_00"],
    ["a query", `/api/diagnostics/refs/${REF}?target=https://elsewhere.test`],
    ["an encoded reference", `/api/diagnostics/refs/${REF.replace("fd1_", "fd1%5F")}`],
    ["a replica reference without its id", `/api/diagnostics/refs/fd2_${"0".repeat(32)}`],
  ])("refuses %s before contacting the gateway", async (_label, url) => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const response = await lookUp(server, url);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTIC_REF_INVALID");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("accepts a replica-tagged reference", async () => {
    const tagged = `fd2_0a1b2c3d_${"e".repeat(32)}`;
    upstream.mockImplementation(async () => Response.json({ ...lookup, ref: tagged, replica_id: "0a1b2c3d" }));
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const response = await lookUp(server, `/api/diagnostics/refs/${tagged}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().replica_id).toBe("0a1b2c3d");
  });

  it.each([
    ["no namespace", {}],
    ["an invalid namespace", { "x-ferrum-namespace": "tenant/a" }],
  ])("refuses %s", async (_label, extra) => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const { "x-ferrum-namespace": _unused, ...rest } = headers;
    headers = rest;
    const response = await lookUp(server, undefined, extra as Record<string, string>);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTIC_NAMESPACE");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("confines a namespace-scoped session to its grants", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin", FERRUM_JWT_NAMESPACES: "tenant-a" });
    const denied = await lookUp(server, undefined, { "x-ferrum-namespace": "tenant-b" });
    expect(denied.statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect((await lookUp(server)).statusCode).toBe(200);
  });

  it.each([
    [404, "FERRUM_BFF_DIAGNOSTIC_NOT_FOUND", 404],
    [403, "FERRUM_BFF_DIAGNOSTICS_DENIED", 403],
    [429, "FERRUM_BFF_DIAGNOSTICS_RATE_LIMITED", 429],
    [500, "FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE", 502],
  ])("maps a gateway %i to %s without relaying its body", async (status, code, answered) => {
    upstream.mockImplementation(async () => Response.json(
      { error: "raw gateway detail that must not reach the browser" },
      { status, headers: status === 404 ? { "x-ferrum-diagnostic-owner-replica": "0a1b2c3d" } : {} },
    ));
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const response = await lookUp(server);
    expect(response.statusCode).toBe(answered);
    expect(response.json().code).toBe(code);
    expect(response.body).not.toContain("raw gateway detail");
    expect(Buffer.byteLength(response.json().error)).toBeLessThanOrEqual(256);
    if (status === 404) expect(response.json().owner_replica).toBe("0a1b2c3d");
    if (status === 429) expect(response.headers["retry-after"]).toBe("1");
  });

  it("refuses an oversized, malformed, too-deep or mismatched answer", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    let deep: unknown = "leaf";
    for (let level = 0; level < 10; level += 1) deep = { deep };
    for (const body of [
      JSON.stringify({ ...lookup, padding: "x".repeat(70 * 1024) }),
      "not json",
      JSON.stringify({ ...lookup, detail: { ...lookup.detail, nested: deep } }),
      JSON.stringify({ ...lookup, ref: `fd1_${"0".repeat(32)}` }),
      JSON.stringify({ ...lookup, namespace: "tenant-b" }),
      JSON.stringify({ ...lookup, status: "502" }),
    ]) {
      upstream.mockImplementationOnce(async () => new Response(body, { headers: { "content-type": "application/json" } }));
      const response = await lookUp(server);
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE");
    }
  });

  it("bounds every projected string and the attempts list", async () => {
    const attempts = Array.from({ length: 12 }, (_, index) => ({ attempt: index + 1, backend_dispatch: "backend_response", status: 503 }));
    upstream.mockImplementation(async () => Response.json({
      ...lookup,
      detail: { ...lookup.detail, proxy_id: "p".repeat(400), attempts, attempts_omitted: 2 },
    }));
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const body = (await lookUp(server)).json();
    expect(body.detail.proxy_id).toHaveLength(256);
    expect(body.detail.attempts).toHaveLength(8);
    expect(body.detail.attempts_omitted).toBe(6);
  });

  it("answers a gateway that does not finish within the deadline with a timeout", async () => {
    upstream.mockImplementation((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const { DIAGNOSTIC_LIMITS, setDiagnosticDeadlineForTesting } = await import("./diagnostics.js");
    expect(DIAGNOSTIC_LIMITS.deadlineMs).toBe(5000);
    setDiagnosticDeadlineForTesting(50);
    try {
      const response = await lookUp(server);
      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTICS_TIMEOUT");
    } finally {
      setDiagnosticDeadlineForTesting(undefined);
    }
  });

  it("holds at most two lookups per principal in flight", async () => {
    const releases: Array<() => void> = [];
    // Only the first two gateway calls are held; any later one answers at once.
    upstream.mockImplementation(() => releases.length < 2
      ? new Promise((resolve) => { releases.push(() => resolve(Response.json(lookup))); })
      : Promise.resolve(Response.json(lookup)));
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    try {
      // light-my-request dispatches an injection only once it is awaited or
      // `then`-ed, so start both explicitly.
      const first = lookUp(server).then((response) => response);
      const second = lookUp(server).then((response) => response);
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      const third = await lookUp(server);
      expect(third.statusCode).toBe(429);
      expect(third.json().code).toBe("FERRUM_BFF_DIAGNOSTICS_CAPACITY");
      for (const release of releases) release();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect((await lookUp(server)).statusCode).toBe(200);
    } finally {
      for (const release of releases) release();
    }
  });

  it("refuses the unreviewed response shapes instead of coercing them", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const { detail_available: _omitted, ...withoutFlag } = lookup;
    for (const body of [
      { ...lookup, schema_version: "ferrum.diagnostic_ref.v2" },
      withoutFlag,
      { ...lookup, detail_available: "true" },
      { ...lookup, detail: { ...lookup.detail, attempts: { attempt: 1 } } },
    ]) {
      upstream.mockImplementationOnce(async () => Response.json(body));
      const response = await lookUp(server);
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE");
    }
  });

  it("keeps an explicit default port and omits an oversized backend target", async () => {
    const { structuralTarget } = await import("./diagnostics.js");
    expect(structuralTarget("https://orders.internal:443/path?token=x")).toBe("https://orders.internal:443");
    expect(structuralTarget("http://user:pass@orders.internal:80")).toBe("http://orders.internal:80");
    expect(structuralTarget("https://orders.internal/x")).toBe("https://orders.internal");
    expect(structuralTarget(`https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}:8443`)).toBeNull();
    expect(structuralTarget("not a url")).toBeNull();
  });

  it("refuses a lookup issued against a replaced gateway target before signing or fetching", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const response = await lookUp(server, undefined, { "x-foundry-gateway-target": "replaced-gateway" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("FERRUM_BFF_GATEWAY_TARGET_CHANGED");
    expect(upstream).not.toHaveBeenCalled();
    const current = await lookUp(server);
    expect(current.statusCode).toBe(200);
    expect(current.headers["x-foundry-gateway-target"]).toEqual(expect.any(String));
  });

  it("answers an overlong or malformed target with a fixed body that echoes nothing", async () => {
    const server = await setup({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    const secret = "https://user:hunter2-secret@elsewhere.test/";
    for (const url of [
      `/api/diagnostics/refs/${encodeURIComponent(secret)}`,
      `/api/diagnostics/refs/${"f".repeat(5000)}`,
      `/api/diagnostics/refs/${REF}/extra`,
    ]) {
      const response = await lookUp(server, url);
      expect(response.statusCode, url.slice(0, 60)).toBe(400);
      expect(response.json().code).toBe("FERRUM_BFF_DIAGNOSTIC_REF_INVALID");
      expect(response.body).not.toContain("hunter2");
      expect(response.body).not.toContain("ffffffffff");
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("diagnostic lookup request logging", () => {
  it("never writes a rejected lookup target to the log, even before authentication", async () => {
    stubEnvironment({ FERRUM_DIAGNOSTICS_ROLES: "admin" });
    let logs = "";
    const { buildApp } = await import("../app.js");
    const app = await buildApp({ serveStatic: false, logger: {
      level: "debug", stream: { write: (chunk: string) => { logs += chunk; } },
    } });
    try {
      const secret = "hunter2-credential-in-a-mistaken-target";
      for (const url of [
        `/api/diagnostics/refs/https%3A%2F%2Fuser%3A${secret}%40elsewhere.test`,
        `/api/diagnostics/refs/${secret}?token=${secret}`,
        `/%61pi/diagnostics/refs/${secret}`,
      ]) {
        await app.inject({ method: "GET", url });
      }
      // The real logger ran, and saw only the fixed projection.
      expect(logs).toContain("Diagnostic lookup request");
      expect(logs).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
