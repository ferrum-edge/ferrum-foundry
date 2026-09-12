import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { jwtVerify } from "jose";
import {
  adminToken,
  buildRestorePayload,
  foreignEnabledGlobalPrometheus,
  prepareRestorePayload,
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
  assert.equal(config.includeBasicAuth, false);

  const optedIn = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
    FERRUM_DEMO_INCLUDE_BASIC_AUTH: "true",
  });
  assert.equal(
    optedIn.destructiveConfirmation,
    "http://127.0.0.1:9000#ferrum-foundry-demo",
  );
  assert.equal(optedIn.includeBasicAuth, true);
  assert.equal(readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_INCLUDE_BASIC_AUTH: "1",
  }).includeBasicAuth, false);
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

  assert.equal(payload.consumers.length, 12);
  assert.equal(payload.proxies.length, 18);
  assert.equal(
    payload.plugin_configs.some((plugin) => plugin.plugin_name === "basic_auth"),
    false,
    "basic_auth demo resources are opt-in",
  );
  assert.equal(
    payload.consumers.some((consumer) => consumer.id.startsWith("demo-basic-consumer-")),
    false,
  );
  const metrics = payload.plugin_configs.find((plugin) => plugin.id === "demo-global-prometheus");
  assert.equal(metrics.plugin_name, "prometheus_metrics");
  assert.equal(metrics.scope, "global");
  assert.equal(metrics.enabled, true);
});

test("restore fixture includes basic_auth resources only when opted in", () => {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const payload = buildRestorePayload(timestamp, { includeBasicAuth: true });

  assert.equal(payload.consumers.length, 18);
  assert.equal(payload.proxies.length, 18);
  assert.equal(payload.counts.consumers, 18);
  assert.equal(payload.counts.plugin_configs, payload.plugin_configs.length);
  const basicPlugins = payload.plugin_configs.filter((plugin) => plugin.plugin_name === "basic_auth");
  assert.equal(basicPlugins.length, 4);
  assert.ok(basicPlugins.every((plugin) => plugin.scope === "proxy" && plugin.enabled));
  assert.equal(
    payload.consumers.filter((consumer) => consumer.credentials.basicauth).length,
    6,
  );
  assert.ok(payload.plugin_configs.some((plugin) => plugin.id === "demo-global-prometheus"));
});

test("restore fixture omits the process-wide prometheus owner when asked", () => {
  const timestamp = "2026-08-30T00:00:00.000Z";
  const payload = buildRestorePayload(timestamp, { omitGlobalPrometheus: true });

  assert.equal(
    payload.plugin_configs.some((plugin) => plugin.plugin_name === "prometheus_metrics"),
    false,
  );
  assert.ok(payload.plugin_configs.some((plugin) => plugin.plugin_name === "correlation_id"));
  assert.equal(payload.counts.plugin_configs, payload.plugin_configs.length);
});

test("foreign enabled global prometheus is the other-namespace owner, not the target", () => {
  assert.deepEqual(foreignEnabledGlobalPrometheus([
    {
      id: "local",
      plugin_name: "prometheus_metrics",
      scope: "global",
      enabled: true,
      namespace: "ferrum-foundry-demo",
    },
    {
      id: "foreign",
      plugin_name: "prometheus_metrics",
      scope: "global",
      enabled: true,
      namespace: "payments",
    },
    {
      id: "disabled",
      plugin_name: "prometheus_metrics",
      scope: "global",
      enabled: false,
      namespace: "ops",
    },
    {
      id: "proxy-scoped",
      plugin_name: "prometheus_metrics",
      scope: "proxy",
      enabled: true,
      namespace: "ops",
    },
    {
      id: "same-namespace-unlabeled",
      plugin_name: "prometheus_metrics",
      scope: "global",
      enabled: true,
    },
  ], "ferrum-foundry-demo").map((plugin) => plugin.id), ["foreign"]);
});

function adminMemory({
  namespaces = ["ferrum-foundry-demo"],
  pluginsByNamespace = {},
  probeError,
} = {}) {
  const calls = [];
  const notices = [];
  const request = async (config, path, options = {}) => {
    const method = options.method ?? "GET";
    const route = path.split("?")[0];
    calls.push({ method, route, namespace: config.namespace, path, body: options.body });
    if (route === "/namespaces" && method === "GET") {
      return {
        data: namespaces,
        pagination: { offset: 0, limit: 100, total: namespaces.length },
      };
    }
    if (route === "/plugins/config" && method === "GET") {
      const data = pluginsByNamespace[config.namespace] ?? [];
      return {
        data,
        pagination: { offset: 0, limit: 100, total: data.length },
      };
    }
    if (route === "/consumers" && method === "POST") {
      if (probeError) throw new Error(probeError);
      return { id: "ff-demo-basic-auth-hmac-probe" };
    }
    if (route.startsWith("/consumers/") && method === "DELETE") {
      return {};
    }
    if (route === "/restore" && method === "POST") {
      return { restored: JSON.parse(options.body) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return {
    calls,
    request,
    report: (notice) => notices.push(notice),
    notices,
  };
}

test("preflight omits a conflicting global prometheus and still restores without it", async () => {
  const config = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
  });
  const admin = adminMemory({
    namespaces: ["payments", "ferrum-foundry-demo"],
    pluginsByNamespace: {
      payments: [{
        id: "payments-prometheus",
        plugin_name: "prometheus_metrics",
        scope: "global",
        enabled: true,
        namespace: "payments",
      }],
    },
  });

  const prepared = await prepareRestorePayload(config, {
    request: admin.request,
    report: admin.report,
  });
  assert.equal(prepared.omitGlobalPrometheus, true);
  assert.equal(
    prepared.payload.plugin_configs.some((plugin) => plugin.plugin_name === "prometheus_metrics"),
    false,
  );
  assert.equal(
    prepared.payload.plugin_configs.some((plugin) => plugin.plugin_name === "basic_auth"),
    false,
  );
  assert.match(prepared.skipped.join("\n"), /payments/);
  assert.match(prepared.skipped.join("\n"), /FERRUM_DEMO_INCLUDE_BASIC_AUTH=true/);
  assert.equal(admin.calls.some((call) => call.route === "/restore"), false);
});

test("missing HMAC secret aborts before restore when basic auth is opted in", async () => {
  const config = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
    FERRUM_DEMO_INCLUDE_BASIC_AUTH: "true",
  });
  const admin = adminMemory({
    probeError: "POST /consumers?apply=sync failed: 500 {\"error\":\"FERRUM_BASIC_AUTH_HMAC_SECRET\"}",
  });

  await assert.rejects(
    runSeed(config, { request: admin.request, report: admin.report }),
    /FERRUM_BASIC_AUTH_HMAC_SECRET/,
  );
  assert.equal(admin.calls.some((call) => call.route === "/restore"), false);
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.route === "/consumers"), true);
});

test("runSeed posts restore only after preflight and omits a foreign prometheus owner", async () => {
  const config = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
    FERRUM_DEMO_MANIFEST: "/tmp/ferrum-foundry-demo-manifest-issue-324.json",
  });
  const admin = adminMemory({
    namespaces: ["payments", "ferrum-foundry-demo"],
    pluginsByNamespace: {
      payments: [{
        id: "payments-prometheus",
        plugin_name: "prometheus_metrics",
        scope: "global",
        enabled: true,
        namespace: "payments",
      }],
    },
  });

  const result = await runSeed(config, { request: admin.request, report: admin.report });
  const restoreIndex = admin.calls.findIndex((call) => call.route === "/restore");
  const namespaceIndex = admin.calls.findIndex((call) => call.route === "/namespaces");
  assert.ok(namespaceIndex >= 0 && namespaceIndex < restoreIndex);
  const restored = JSON.parse(admin.calls[restoreIndex].body);
  assert.equal(
    restored.plugin_configs.some((plugin) => plugin.plugin_name === "prometheus_metrics"),
    false,
  );
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0], /payments/);
});

test("preflight keeps the demo prometheus owner when only the target namespace has it", async () => {
  const config = readSeedConfig({
    FERRUM_JWT_SECRET: SIGNING_SECRET,
    FERRUM_DEMO_CONFIRM_TARGET: "http://127.0.0.1:9000#ferrum-foundry-demo",
    FERRUM_DEMO_INCLUDE_BASIC_AUTH: "true",
  });
  const admin = adminMemory({
    pluginsByNamespace: {
      "ferrum-foundry-demo": [{
        id: "demo-global-prometheus",
        plugin_name: "prometheus_metrics",
        scope: "global",
        enabled: true,
        namespace: "ferrum-foundry-demo",
      }],
    },
  });

  const prepared = await prepareRestorePayload(config, {
    request: admin.request,
    report: admin.report,
  });
  assert.equal(prepared.omitGlobalPrometheus, false);
  assert.ok(prepared.payload.plugin_configs.some((plugin) => plugin.id === "demo-global-prometheus"));
  assert.equal(prepared.payload.plugin_configs.filter((plugin) => plugin.plugin_name === "basic_auth").length, 4);
  assert.equal(prepared.skipped.length, 0);
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.route === "/consumers"), true);
  assert.equal(admin.calls.some((call) => call.route === "/restore"), false);
});

test("seed confirmation still happens before any Admin API request", () => {
  const source = readFileSync(new URL("./seed-demo-gateway.mjs", import.meta.url), "utf8");
  const confirmAt = source.indexOf("confirmDestructiveTarget(config)");
  const prepareAt = source.indexOf("await prepareRestorePayload(");
  const restoreAt = source.indexOf("/restore?confirm=true");
  assert.ok(confirmAt >= 0 && prepareAt >= 0 && restoreAt >= 0);
  assert.ok(confirmAt < prepareAt);
  assert.ok(prepareAt < restoreAt);
});
