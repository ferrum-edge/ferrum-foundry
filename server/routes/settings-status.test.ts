import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: upstream,
}));

// These are synthetic test inputs, never deployment credentials.
const loginToken = "settings-status-development-fixture-long-enough";
let app: FastifyInstance | undefined;
let headers: Record<string, string>;

beforeEach(() => {
  vi.resetModules();
  upstream.mockReset();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FERRUM_")) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    FERRUM_ADMIN_URL: "https://gateway.example.test",
    FERRUM_ADMIN_ALLOWED_ORIGINS: "https://gateway.example.test,https://next.example.test",
    FERRUM_ALLOW_RUNTIME_SETTINGS: "true",
    FERRUM_AUTH_MODE: "static",
    FERRUM_JWT_SECRET: "settings-status-signing-fixture-long-enough",
    FERRUM_BFF_AUTH_TOKEN: loginToken,
    FERRUM_SECURE_COOKIES: "false",
  })) vi.stubEnv(key, value);
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  const { closeDispatchers } = await import("../tls.js");
  await closeDispatchers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup() {
  const { authPlugin } = await import("../auth.js");
  const { default: settingsPlugin } = await import("./settings.js");
  app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(settingsPlugin);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { token: loginToken } });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "),
    "x-csrf-token": login.json().csrfToken as string,
  };
  return app;
}

describe("settings status publication", () => {
  it("authenticates the health probe with the accepted signing and transport generation", async () => {
    const server = await setup();
    const before = await server.inject({ method: "GET", url: "/api/auth/session", headers });
    const save = await server.inject({
      method: "PUT", url: "/api/settings", headers,
      payload: {
        adminUrl: "https://next.example.test", jwtIssuer: "new-issuer", jwtAudience: "edge-health",
        connectTimeout: 6000, readTimeout: 7000, writeTimeout: 8000,
      },
    });
    expect(save.statusCode).toBe(200);
    upstream.mockResolvedValue(Response.json({ ready: true, mode: "database" }));
    const response = await server.inject({ method: "GET", url: "/api/settings/status", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reachable: true, status: 200, body: { ready: true, mode: "database" } });
    const [url, options] = upstream.mock.calls[0];
    expect(String(url)).toBe("https://next.example.test/health");
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    const claims = decodeJwt(options.headers.authorization.replace(/^Bearer /, ""));
    expect(claims).toMatchObject({
      sub: before.json().principal.subject, role: "admin", iss: "new-issuer", aud: "edge-health",
    });
    const { getDispatcher } = await import("../tls.js");
    const { loadConfig } = await import("../config.js");
    expect(options.dispatcher).toBe(getDispatcher(loadConfig()));
    expect(options.signal.aborted).toBe(false);
  });

  it.each([
    [200, "{\"ready\":false}", { ready: false }, true],
    [503, "gateway unavailable", "gateway unavailable", false],
    [200, "", "", true],
  ] as const)("preserves status %s and the gateway body", async (status, body, expected, reachable) => {
    const server = await setup();
    upstream.mockResolvedValue(new Response(body || null, { status }));
    const response = await server.inject({ method: "GET", url: "/api/settings/status", headers });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ reachable, status, body: expected });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("decodes UTF-8 characters split across chunks", async () => {
    const server = await setup();
    const bytes = new TextEncoder().encode('{"message":"é"}');
    upstream.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    })));
    const response = await server.inject({ method: "GET", url: "/api/settings/status", headers });
    expect(response.json()).toEqual({ reachable: true, status: 200, body: { message: "é" } });
  });

  it.each([65536, 65537])("bounds a %s-byte status body and cancels the reader", async (size) => {
    const server = await setup();
    const cancel = vi.fn(async () => { throw new Error("already closed"); });
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(size).fill(65) })
      .mockResolvedValue({ done: true });
    upstream.mockResolvedValue({ status: 200, ok: true, body: { getReader: () => ({ read, cancel }) } });
    const response = await server.inject({ method: "GET", url: "/api/settings/status", headers });
    if (size === 65536) {
      expect(response.statusCode).toBe(200);
      expect(response.json().body).toHaveLength(size);
    } else {
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ reachable: false, code: "FERRUM_BFF_UPSTREAM_FAILURE" });
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["AbortError", "TypeError"])("redacts %s failures", async (name) => {
    const server = await setup();
    upstream.mockRejectedValue(Object.assign(new Error("private connection details"), { name }));
    const response = await server.inject({ method: "GET", url: "/api/settings/status", headers });
    expect(response.statusCode).toBe(name === "AbortError" ? 504 : 502);
    expect(response.json()).toEqual({
      reachable: false, code: name === "AbortError" ? "FERRUM_BFF_TIMEOUT" : "FERRUM_BFF_UPSTREAM_FAILURE",
    });
    expect(response.body).not.toContain("private connection details");
  });

  it("aborts a stalled upstream at the configured deadline and clears its timer", async () => {
    vi.stubEnv("FERRUM_READ_TIMEOUT", "100");
    const server = await setup();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    upstream.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")));
      entered();
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = server.inject({ method: "GET", url: "/api/settings/status", headers })
      .then((response) => response);
    await started;
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ reachable: false, code: "FERRUM_BFF_TIMEOUT" });
    expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["anonymous", "viewer", "operator"])("refuses a %s status probe before contacting the gateway", async (role) => {
    if (role !== "anonymous") vi.stubEnv("FERRUM_JWT_ROLE", role);
    const server = await setup();
    const response = await server.inject({
      method: "GET", url: "/api/settings/status", headers: role === "anonymous" ? {} : headers,
    });
    expect(response.statusCode).toBe(role === "anonymous" ? 401 : 403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("settings mutation publication boundaries", () => {
  it("keeps immutable settings unchanged", async () => {
    vi.stubEnv("FERRUM_ALLOW_RUNTIME_SETTINGS", "false");
    const server = await setup();
    const before = await server.inject({ method: "GET", url: "/api/settings", headers });
    const result = await server.inject({ method: "PUT", url: "/api/settings", headers, payload: { jwtIssuer: "changed" } });
    expect(result.statusCode).toBe(403);
    expect(result.json().code).toBe("FERRUM_BFF_SETTINGS_IMMUTABLE");
    const after = await server.inject({ method: "GET", url: "/api/settings", headers });
    expect(after.json()).toEqual(before.json());
  });

  it.each(["null", "[]", "123", '"text"'])("rejects non-object JSON %s", async (payload) => {
    const server = await setup();
    const response = await server.inject({
      method: "PUT", url: "/api/settings", headers: { ...headers, "content-type": "application/json" }, payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Settings body must be an object");
  });

  it("does not partially publish a valid field when another field fails validation", async () => {
    const server = await setup();
    const before = await server.inject({ method: "GET", url: "/api/settings", headers });
    const response = await server.inject({
      method: "PUT", url: "/api/settings", headers,
      payload: { jwtIssuer: "must-not-apply", readTimeout: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FERRUM_BFF_INVALID_SETTINGS");
    const after = await server.inject({ method: "GET", url: "/api/settings", headers });
    expect(after.json()).toEqual(before.json());
  });

  it("audits accepted fields while redacting connection locations", async () => {
    const server = await setup();
    const info = vi.spyOn(server.log, "info");
    const response = await server.inject({
      method: "PUT", url: "/api/settings", headers,
      payload: { adminUrl: "https://next.example.test", jwtIssuer: "audited-issuer" },
    });
    expect(response.statusCode).toBe(200);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.any(String), changedFields: ["adminUrl", "jwtIssuer"],
      changes: {
        adminUrl: "[redacted connection setting]",
        jwtIssuer: { before: expect.any(String), after: "audited-issuer" },
      },
    }), "Runtime settings changed");
    expect(response.json()).not.toHaveProperty("tlsCaPath");
    expect(response.json()).not.toHaveProperty("jwtSecret");
  });
});
