/* ------------------------------------------------------------------ */
/*  The first-success walkthrough, executed (issue #384)               */
/* ------------------------------------------------------------------ */

/**
 * Runs `docs/getting-started.md` end to end against a running starter stack
 * and asserts the outcomes the documentation claims, so the docs and the
 * runnable configuration cannot drift apart.
 *
 * It exercises the identity boundary first — an anonymous caller, an
 * authenticated caller in no Ferrum group, a forged identity header, and each
 * mapped role — and then the route itself, finishing with the two data-plane
 * requests that are the actual proof: anonymous refused, authenticated served.
 *
 * It is destructive **only** inside the namespace it is pointed at, and only
 * for the four `starter-*` resources it creates and then deletes. It refuses
 * to run without `FERRUM_STARTER_CONFIRM_TARGET` naming that exact target, so
 * it cannot be aimed at a namespace someone cares about by accident.
 *
 *   FERRUM_STARTER_CONFIRM_TARGET='http://127.0.0.1:8088#ferrum-foundry-demo' \
 *   node scripts/starter-journey.mjs
 */

import assert from "node:assert/strict";

const FOUNDRY = process.env.FOUNDRY_URL ?? "http://127.0.0.1:8088";
const DATA_PLANE = process.env.FERRUM_DATA_PLANE_URL ?? "http://127.0.0.1:8000";
const NAMESPACE = process.env.FERRUM_NAMESPACE ?? "ferrum-foundry-demo";
const BACKEND_HOST = process.env.FERRUM_STARTER_BACKEND_HOST ?? "demo-backend";
const BACKEND_PORT = Number(process.env.FERRUM_STARTER_BACKEND_PORT ?? "8081");
const IDENTITY_HEADER = "X-Demo-Identity";
const API_KEY = process.env.FERRUM_STARTER_API_KEY ?? "starter-demo-key-do-not-reuse";

const RESOURCES = {
  upstream: "starter-upstream",
  proxy: "starter-route",
  plugin: "starter-keyauth",
  consumer: "starter-consumer",
};

function confirmTarget() {
  const expected = `${FOUNDRY}#${NAMESPACE}`;
  if (process.env.FERRUM_STARTER_CONFIRM_TARGET !== expected) {
    throw new Error(
      `Refusing to write to ${JSON.stringify(NAMESPACE)}. ` +
        `FERRUM_STARTER_CONFIRM_TARGET must exactly equal ${JSON.stringify(expected)}.`,
    );
  }
}

/* ------------------------------------------------------------------ */

const checks = [];
function record(name, detail) {
  checks.push({ name, detail });
  console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function status(path, init = {}) {
  const response = await fetch(`${FOUNDRY}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
  return response.status;
}

/** The identity boundary, before anything is created. */
async function checkIdentityBoundary() {
  const admin = `/api/proxy/proxies?offset=0&limit=1`;
  const scoped = { "X-Ferrum-Namespace": NAMESPACE };

  assert.equal(
    await status(admin, { headers: scoped }),
    401,
    "an anonymous caller reached an admin route",
  );
  record("anonymous is refused");

  assert.equal(
    await status(admin, { headers: { ...scoped, [IDENTITY_HEADER]: "unmapped" } }),
    401,
    "an identity in no Ferrum group was admitted",
  );
  record("an authenticated user in no Ferrum group is refused");

  assert.equal(
    await status(admin, {
      headers: {
        ...scoped,
        "X-Ferrum-Auth-Secret": process.env.FERRUM_TRUSTED_PROXY_SECRET ?? "forged",
        "X-Forwarded-User": "mallory",
        "X-Ferrum-Role": "admin",
        "X-Ferrum-Namespaces": NAMESPACE,
      },
    }),
    401,
    "a forged identity header was served; the proxy is not replacing it",
  );
  record("client identity headers are stripped");

  for (const role of ["viewer", "operator", "admin"]) {
    assert.equal(
      await status(admin, { headers: { ...scoped, [IDENTITY_HEADER]: role } }),
      200,
      `${role} could not read`,
    );
  }
  record("viewer, operator, and admin can read the granted namespace");

  assert.equal(
    await status(admin, {
      headers: { "X-Ferrum-Namespace": "a-namespace-nobody-granted", [IDENTITY_HEADER]: "admin" },
    }),
    403,
    "a namespace outside the grant was served",
  );
  record("a namespace outside the grant is refused");

  assert.equal(
    await status("/api/proxy/upstreams", {
      method: "POST",
      headers: { ...scoped, [IDENTITY_HEADER]: "viewer", "content-type": "application/json" },
      body: JSON.stringify({ id: "should-not-exist", algorithm: "round_robin", targets: [] }),
    }),
    403,
    "a write without a CSRF grant was accepted",
  );
  record("a write without a session and CSRF grant is refused");
}

/* ------------------------------------------------------------------ */

/** An administrator session, as the SPA establishes one. */
async function openSession() {
  const response = await fetch(`${FOUNDRY}/api/auth/session`, {
    headers: { [IDENTITY_HEADER]: "admin" },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, "could not open an administrator session");
  const cookies = (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const { csrfToken } = await response.json();
  assert.ok(csrfToken, "the session carried no CSRF token");
  return {
    headers: {
      [IDENTITY_HEADER]: "admin",
      "X-Ferrum-Namespace": NAMESPACE,
      "X-CSRF-Token": csrfToken,
      cookie: cookies,
      "content-type": "application/json",
    },
  };
}

async function write(session, method, path, body) {
  const response = await fetch(`${FOUNDRY}${path}`, {
    method,
    headers: session.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function read(session, path) {
  const response = await fetch(`${FOUNDRY}${path}`, {
    headers: session.headers,
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function dataPlane(headers = {}) {
  const response = await fetch(`${DATA_PLANE}/starter/hello`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.text() };
}

/* ------------------------------------------------------------------ */

async function removeResources(session) {
  for (const path of [
    `/api/proxy/plugins/config/${RESOURCES.plugin}?apply=sync`,
    `/api/proxy/proxies/${RESOURCES.proxy}?apply=sync&cleanup_orphaned_upstream=false`,
    `/api/proxy/consumers/${RESOURCES.consumer}?apply=sync`,
    `/api/proxy/upstreams/${RESOURCES.upstream}?apply=sync`,
  ]) {
    await write(session, "DELETE", path).catch(() => undefined);
  }
}

async function runWalkthrough(session) {
  const upstream = await write(session, "POST", "/api/proxy/upstreams?apply=sync", {
    id: RESOURCES.upstream,
    name: "Starter backend",
    algorithm: "round_robin",
    targets: [{ host: BACKEND_HOST, port: BACKEND_PORT, weight: 1 }],
  });
  assert.ok([200, 201].includes(upstream.status), `upstream create: ${upstream.status}`);

  const proxy = await write(session, "POST", "/api/proxy/proxies?apply=sync", {
    id: RESOURCES.proxy,
    name: "Starter route",
    listen_path: "/starter",
    backend_scheme: "http",
    backend_host: BACKEND_HOST,
    backend_port: BACKEND_PORT,
    upstream_id: RESOURCES.upstream,
    strip_listen_path: true,
    hosts: [],
  });
  assert.ok([200, 201].includes(proxy.status), `proxy create: ${proxy.status}`);
  record("upstream and route created");

  const open = await dataPlane();
  assert.equal(open.status, 200, "the new route did not serve traffic");
  record("the route serves traffic through the real data plane");

  const plugin = await write(session, "POST", "/api/proxy/plugins/config?apply=sync", {
    id: RESOURCES.plugin,
    plugin_name: "key_auth",
    scope: "proxy",
    proxy_id: RESOURCES.proxy,
    enabled: true,
    config: { key_location: "header:X-API-Key" },
  });
  assert.ok([200, 201].includes(plugin.status), `plugin create: ${plugin.status}`);

  // Creating a proxy-scoped plugin configuration does not attach it. The
  // association lives on the proxy, and a full-replacement PUT carries it.
  // The walkthrough documents this because skipping it leaves the route open
  // while everything looks configured.
  const stillOpen = await dataPlane();
  assert.equal(
    stillOpen.status,
    200,
    "the plugin took effect without an association; re-check the walkthrough",
  );
  record("a plugin configuration alone does not protect the route");

  const current = await read(session, `/api/proxy/proxies/${RESOURCES.proxy}`);
  for (const field of ["created_at", "updated_at", "namespace", "api_spec_id"]) {
    delete current[field];
  }
  const attached = await write(
    session,
    "PUT",
    `/api/proxy/proxies/${RESOURCES.proxy}?apply=sync`,
    { ...current, plugins: [{ plugin_config_id: RESOURCES.plugin }] },
  );
  assert.equal(attached.status, 200, `attach: ${attached.status}`);

  const consumer = await write(session, "POST", "/api/proxy/consumers?apply=sync", {
    id: RESOURCES.consumer,
    username: "starter-client",
    credentials: { keyauth: [{ key: API_KEY }] },
  });
  assert.ok([200, 201].includes(consumer.status), `consumer create: ${consumer.status}`);
  record("key authentication attached and a consumer credential created");

  // Ordinary reads redact the credential; the UI shows it once at creation.
  const stored = await read(session, `/api/proxy/consumers/${RESOURCES.consumer}`);
  const storedKey = stored.credentials?.keyauth?.[0]?.key;
  assert.notEqual(storedKey, API_KEY, "a stored credential was returned in the clear");
  record("the stored credential is redacted on read", String(storedKey));

  const anonymous = await dataPlane();
  assert.equal(
    anonymous.status,
    401,
    `anonymous data-plane request returned ${anonymous.status}; the route is not protected`,
  );
  record("anonymous is refused at the data plane");

  const authenticated = await dataPlane({ "X-API-Key": API_KEY });
  assert.equal(
    authenticated.status,
    200,
    `authenticated data-plane request returned ${authenticated.status}`,
  );
  const payload = JSON.parse(authenticated.body);
  assert.equal(
    payload.saw_api_key,
    false,
    "the backend received the API key; key_auth should hide credentials by default",
  );
  record("authenticated succeeds, and the credential is hidden from the backend");
}

/* ------------------------------------------------------------------ */

confirmTarget();
console.log(`Starter journey against ${FOUNDRY} (namespace ${NAMESPACE})\n`);

console.log("Identity boundary:");
await checkIdentityBoundary();

console.log("\nFirst route:");
const session = await openSession();
await removeResources(session);
try {
  await runWalkthrough(session);
} finally {
  await removeResources(session);
}

console.log(`\n${checks.length} checks passed.`);
