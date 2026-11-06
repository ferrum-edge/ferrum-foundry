import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_PLUGIN_CONFIGS, getPluginConfigDefault } from "../src/lib/pluginConfigDefaults.ts";
import {
  OPERATOR_INPUT_REQUIRED,
  OPERATOR_INPUT_REJECTIONS,
  assertOnlyRequiredOperatorInputs,
  verifyPluginDefaults,
} from "./plugin-defaults-contract.mjs";

const ONLY_SESSION_ENCRYPTION_SECRET_MAY_PATTERN =
  /only session\.encryption_secret may differ from Foundry's defaults/;
const ENCODE_32_RANDOM_BYTES_PATTERN = /encode 32 random bytes/;
const REJECTION_REASON_DRIFT_PATTERN = /rejection reason drift/;
const EXPECTED_400_RECEIVED_201_PATTERN = /expected 400, received 201/;
const CORRELATION_ID_EXPECTED_201_RECEIVED_400_PATTERN =
  /correlation_id: expected 201, received 400/;
const MTLS_AUTH_EXPECTED_400_RECEIVED_503_PATTERN = /mtls_auth: expected 400, received 503/;
const SAME_NON_INTERNAL_CATALOG_PATTERN = /same non-internal catalog/;
const PROMETHEUS_METRICS_EXPECTED_201_RECEIVED_PATTERN =
  /prometheus_metrics: expected 201, received 409/;
const KAFKA_LOGGING_REJECTION_REASON_DRIFT_PATTERN = /kafka_logging: rejection reason drift/;
const CLEANUP_EXPECTED_200_204_404_PATTERN = /cleanup:.*expected 200\/204\/404, received 503/;
const EXPECTED_201_RECEIVED_400_PATTERN = /expected 201, received 400/;
const CLEANUP_TRANSPORT_FAILED_PATTERN = /cleanup transport failed/;

// This transport double tests the gate's failure behavior. Real validation is
// exclusively the existing Pinned Gateway Contract job's enabled submissions.
function transport(override = () => undefined) {
  const writes = [];
  const plugins = new Map();
  const proxies = new Map();
  const exchange = async (path, { method = "GET", body } = {}) => {
    const route = path.split("?")[0];
    if (route === "/plugins") return { status: 200, body: Object.keys(DEFAULT_PLUGIN_CONFIGS) };
    if (method === "POST" && route === "/proxies") {
      proxies.set(body.id, body);
      return { status: 201, body };
    }
    if (method === "POST" && route === "/plugins/config") {
      // Every previous plugin must have been removed before admitting another.
      assert.equal(plugins.size, 0);
      writes.push(structuredClone(body));
      const expected = OPERATOR_INPUT_REJECTIONS[body.plugin_name];
      const response = override(body) ?? (expected
        ? { status: expected.status, body: { error: expected.error } }
        : { status: 201, body });
      if (response.status === 201) plugins.set(body.id, body);
      return response;
    }
    const id = route.split("/").at(-1);
    const records = route.startsWith("/plugins/config/") ? plugins : proxies;
    if (method === "DELETE") return { status: records.delete(id) ? 204 : 404 };
    assert.ok(records.has(id), `unexpected read: ${route}`);
    return { status: 200, body: records.get(id) };
  };
  return { exchange, writes, plugins, proxies };
}

const quiet = { report: () => {} };

test("hosted lifecycle admits the catalog before seeding the process-wide metrics owner", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.scripts["test:gateway-contract"].split(" && "), [
    "node scripts/gateway-contract-smoke.mjs",
    "node scripts/seed-demo-gateway.mjs",
    "node scripts/seed-demo-gateway.mjs",
    "node scripts/verify-demo-gateway.mjs",
    "node scripts/demo-route-smoke.mjs",
  ]);

  const smoke = readFileSync(new URL("./gateway-contract-smoke.mjs", import.meta.url), "utf8");
  assert.ok(
    smoke.indexOf("confirmDestructiveTarget(config)") < smoke.indexOf("await request("),
    "the target confirmation must run before the smoke's first Admin API request",
  );
});

test("submits enabled defaults with a generated OIDC key", async () => {
  const fixture = transport();
  assert.deepEqual(await verifyPluginDefaults(fixture.exchange, quiet), {
    templates: 81, accepted: 74, operatorInput: 8,
  });
  assert.equal(fixture.writes.length, 81);
  assert.ok(OPERATOR_INPUT_REQUIRED.oidc_relying_party);
  const oidcWrite = fixture.writes.find((write) => write.plugin_name === "oidc_relying_party");
  assert.ok(oidcWrite);
  assert.equal(oidcWrite.enabled, true);
  assert.ok(Buffer.from(oidcWrite.config.session.encryption_secret, "base64").length >= 32);
  for (const write of fixture.writes) {
    assertOnlyRequiredOperatorInputs(write.plugin_name, write.config);
    assert.equal(write.enabled, true);
    const needsProxy = ["openapi_validator", "tcp_connection_throttle"].includes(write.plugin_name);
    assert.equal(write.scope, needsProxy ? "proxy" : "global");
    assert.equal(Boolean(write.proxy_id), needsProxy);
  }
  assert.equal(fixture.plugins.size, 0);
  assert.equal(fixture.proxies.size, 0);
});

test("operator-input admission permits only the declared generated secret", () => {
  const name = "oidc_relying_party";
  const requiredInput = OPERATOR_INPUT_REQUIRED[name];
  const config = getPluginConfigDefault(name);
  config.session.encryption_secret = Buffer.alloc(32, 0xab).toString("base64");
  assertOnlyRequiredOperatorInputs(name, config);

  const withUndeclaredChange = structuredClone(config);
  withUndeclaredChange.session.cookie_name = "changed-cookie";
  assert.throws(
    () => assertOnlyRequiredOperatorInputs(name, withUndeclaredChange),
    ONLY_SESSION_ENCRYPTION_SECRET_MAY_PATTERN,
  );

  const shortSecret = structuredClone(config);
  shortSecret.session.encryption_secret = Buffer.alloc(31, 0xab).toString("base64");
  assert.throws(() => assertOnlyRequiredOperatorInputs(name, shortSecret), ENCODE_32_RANDOM_BYTES_PATTERN);

  const unchangedDefault = getPluginConfigDefault(name);
  assert.equal(unchangedDefault.session.encryption_secret, "");
  assert.throws(
    () => assertOnlyRequiredOperatorInputs(name, unchangedDefault),
    new RegExp(`${requiredInput.replaceAll(".", "\\.")} must differ from Foundry's default`),
  );
});

test("mesh_authz template is native MeshPolicy input rather than a CRD rejection", () => {
  assert.equal(OPERATOR_INPUT_REJECTIONS.mesh_authz, undefined);
  const config = getPluginConfigDefault("mesh_authz");
  assert.equal(config.namespace, "default");
  assert.deepEqual(config.labels, { app: "payments" });
  assert.ok(Array.isArray(config.mesh_policies));
  assert.equal(config.mesh_policies.length, 2);
  for (const policy of config.mesh_policies) {
    assert.equal(typeof policy.name, "string");
    assert.equal(typeof policy.namespace, "string");
    assert.equal(typeof policy.scope.kind, "string");
    assert.ok(Array.isArray(policy.rules));
    for (const rule of policy.rules) {
      assert.equal(typeof rule.action, "string");
    }
    assert.equal(policy.apiVersion, undefined);
    assert.equal(policy.kind, undefined);
    assert.equal(policy.metadata, undefined);
    assert.equal(policy.spec, undefined);
  }
});

for (const name of Object.keys(OPERATOR_INPUT_REJECTIONS)) {
  test(`${name}: rejects an unrelated 400 instead of hiding unknown-key drift`, async () => {
    const fixture = transport((body) => body.plugin_name === name
      ? { status: 400, body: { error: `${OPERATOR_INPUT_REJECTIONS[name].error}; unknown config key 'drift'` } }
      : undefined);
    await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), REJECTION_REASON_DRIFT_PATTERN);
    assert.equal(fixture.writes.length, 81, "continue through all templates after a failure");
  });

  test(`${name}: unexpected acceptance fails and is cleaned up`, async () => {
    const fixture = transport((body) => body.plugin_name === name ? { status: 201, body } : undefined);
    await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), EXPECTED_400_RECEIVED_201_PATTERN);
    assert.equal(fixture.writes.length, 81);
    assert.equal(fixture.plugins.size, 0);
    assert.equal(fixture.proxies.size, 0);
  });
}

test("an accepted control's rejection and an exemption's wrong status both fail", async () => {
  const fixture = transport((body) => {
    if (body.plugin_name === "correlation_id") return { status: 400, body: { error: "new required key" } };
    if (body.plugin_name === "mtls_auth") return { status: 503, body: { error: OPERATOR_INPUT_REJECTIONS.mtls_auth.error } };
  });
  await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), (error) => {
    assert.equal(error.errors.length, 2);
    assert.match(error.message, CORRELATION_ID_EXPECTED_201_RECEIVED_400_PATTERN);
    assert.match(error.message, MTLS_AUTH_EXPECTED_400_RECEIVED_503_PATTERN);
    return true;
  });
  assert.equal(fixture.writes.length, 81);
});

test("gateway catalog drift fails before any submission", async () => {
  const fixture = transport();
  await assert.rejects(verifyPluginDefaults((path, options) => path === "/plugins"
    ? { status: 200, body: Object.keys(DEFAULT_PLUGIN_CONFIGS).filter((name) => name !== "compression") }
    : fixture.exchange(path, options), quiet), SAME_NON_INTERNAL_CATALOG_PATTERN);
  assert.equal(fixture.writes.length, 0);
});

test("a Prometheus registry conflict fails rather than exempting the template", async () => {
  const fixture = transport((body) => body.plugin_name === "prometheus_metrics"
    ? { status: 409, body: { error: "prometheus_metrics permits at most one enabled global instance; another config already owns the process registry" } }
    : undefined);
  await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), PROMETHEUS_METRICS_EXPECTED_201_RECEIVED_PATTERN);
  assert.equal(fixture.writes.length, 81);
});

test("Kafka's constructor-error prefix cannot substitute for the egress field-validation error", async () => {
  const fixture = transport((body) => body.plugin_name === "kafka_logging"
    ? { status: 400, body: { error: OPERATOR_INPUT_REJECTIONS.kafka_logging.error.replace("Invalid plugin config fields:", "Invalid plugin config:") } }
    : undefined);
  await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), KAFKA_LOGGING_REJECTION_REASON_DRIFT_PATTERN);
  assert.equal(fixture.writes.length, 81);
});

test("cleanup failure fails the gate and stops potentially contaminated submissions", async () => {
  const fixture = transport();
  await assert.rejects(verifyPluginDefaults((path, options) => options?.method === "DELETE"
    ? { status: 503, body: { error: "cleanup unavailable" } }
    : fixture.exchange(path, options), quiet), CLEANUP_EXPECTED_200_204_404_PATTERN);
  assert.equal(fixture.writes.length, 1);
});

test("admission and thrown cleanup failures are both reported before stopping", async () => {
  const fixture = transport(() => ({ status: 400, body: { error: "admission failed" } }));
  let report;
  await assert.rejects(verifyPluginDefaults((path, options) => {
    if (options?.method === "DELETE") throw new Error("cleanup transport failed");
    return fixture.exchange(path, options);
  }, { report: (value) => { report = JSON.parse(value); } }), (error) => {
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, EXPECTED_201_RECEIVED_400_PATTERN);
    assert.match(error.errors[1].message, CLEANUP_TRANSPORT_FAILED_PATTERN);
    return true;
  });
  assert.equal(fixture.writes.length, 1);
  assert.equal(report.pluginDefaults.length, 1);
});
