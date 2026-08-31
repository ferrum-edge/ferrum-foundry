import assert from "node:assert/strict";
import test from "node:test";
import { jwtVerify } from "jose";
import {
  adminToken,
  buildRestorePayload,
  readSeedConfig,
  runSeed,
} from "./seed-demo-gateway.mjs";

const SIGNING_SECRET = "contract-test-signing-secret-at-least-32-characters";

test("demo admin token matches the Ferrum admin claim contract", async () => {
  const now = 1_900_000_000;
  const token = await adminToken({
    jwtSecret: SIGNING_SECRET,
    jwtIssuer: "ferrum-edge",
    jwtAudience: ["admin-api", "operations"],
    namespace: "ferrum-foundry-demo",
  }, { now, jti: "contract-test-jti" });

  const { payload, protectedHeader } = await jwtVerify(
    token,
    new TextEncoder().encode(SIGNING_SECRET),
    {
      algorithms: ["HS256"],
      issuer: "ferrum-edge",
      audience: "admin-api",
      currentDate: new Date(now * 1000),
    },
  );

  assert.equal(protectedHeader.alg, "HS256");
  assert.equal(payload.sub, "ferrum-foundry-demo-seeder");
  assert.equal(payload.role, "admin");
  assert.equal(payload.ns, "ferrum-foundry-demo");
  assert.deepEqual(payload.aud, ["admin-api", "operations"]);
  assert.equal(payload.iat, now);
  assert.equal(payload.nbf, now);
  assert.equal(payload.exp, now + 900);
  assert.equal(payload.jti, "contract-test-jti");
});

test("demo seeder has no fallback signing credential and requires a target-bound confirmation", () => {
  assert.throws(() => readSeedConfig({}), /FERRUM_JWT_SECRET is required/);

  const config = readSeedConfig({ FERRUM_JWT_SECRET: SIGNING_SECRET });
  assert.equal(config.namespace, "ferrum-foundry-demo");
  assert.equal(config.destructiveConfirmation, undefined);
  assert.equal(config.backendHost, "127.0.0.1");
  assert.equal(config.proxyBaseUrl, "http://127.0.0.1:8000");

  const optedIn = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
  });
  assert.equal(
    optedIn.destructiveConfirmation,
    "http://127.0.0.1:9000#ferrum-foundry-demo",
  );
  assert.throws(() => readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_BACKEND_HOST: "backend:9101",
  }), /DNS hostname without a port/);
});

test("demo seeder rejects a confirmation copied from a different target before HTTP", async () => {
  const config = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_ADMIN_URL: "https://gateway.example",
    FERRUM_NAMESPACE: "payments",
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
  });
  await assert.rejects(
    runSeed(config),
    /must exactly equal "https:\/\/gateway\.example#payments"/,
  );
});

test("restore fixture uses current resource names and versioned API-spec semantics", () => {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const payload = buildRestorePayload(timestamp);

  assert.equal(payload.version, "1");
  assert.match(payload.ferrum_version, /^contract-[0-9a-f]{40}$/);
  assert.deepEqual(payload.api_specs, { section_version: "2", items: [] });
  assert.equal(payload.exported_at, timestamp);
  assert.equal(payload.counts.consumers, payload.consumers.length);
  assert.equal(payload.counts.upstreams, payload.upstreams.length);
  assert.equal(payload.counts.proxies, payload.proxies.length);
  assert.equal(payload.counts.plugin_configs, payload.plugin_configs.length);

  for (const proxy of payload.proxies) {
    assert.equal(proxy.backend_scheme, "http");
    assert.equal(Object.hasOwn(proxy, "backend_protocol"), false);
    assert.deepEqual(proxy.allowed_ws_origins, ["http://localhost:5173", "http://localhost:8000"]);
    assert.ok(proxy.id);
  }

  const containerPayload = buildRestorePayload(timestamp, { backendHost: "host.docker.internal" });
  assert.ok(containerPayload.upstreams.every((upstream) => (
    upstream.targets.every((target) => target.host === "host.docker.internal")
  )));
  assert.ok(containerPayload.proxies.every((proxy) => proxy.backend_host === "host.docker.internal"));

  for (const consumer of payload.consumers) {
    assert.ok(consumer.id);
    for (const entries of Object.values(consumer.credentials)) {
      assert.ok(Array.isArray(entries));
      assert.ok(entries.length > 0);
    }
    for (const credential of consumer.credentials.jwt ?? []) {
      assert.ok(credential.secret.length >= 32);
    }
  }

  for (const resource of [...payload.upstreams, ...payload.plugin_configs]) {
    assert.ok(resource.id);
  }

  const correlation = payload.plugin_configs.find((plugin) => plugin.plugin_name === "correlation_id");
  assert.deepEqual(correlation.config, {
    header_name: "X-Correlation-ID",
    echo_downstream: true,
  });
  const rateLimits = payload.plugin_configs.filter((plugin) => plugin.plugin_name === "rate_limiting");
  assert.ok(rateLimits.length > 0);
  assert.ok(rateLimits.every((plugin) => (
    Array.isArray(plugin.config.limits)
    && plugin.config.limits.some((rule) => rule.scope === "default")
    && !Object.hasOwn(plugin.config, "requests_per_second")
  )));
});
