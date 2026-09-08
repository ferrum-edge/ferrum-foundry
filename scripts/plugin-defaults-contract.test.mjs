import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_PLUGIN_CONFIGS, getPluginConfigDefault } from "../src/lib/pluginConfigDefaults.ts";
import { OPERATOR_INPUT_REJECTIONS, verifyPluginDefaults } from "./plugin-defaults-contract.mjs";

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
});

test("submits all 81 actual enabled defaults unchanged, in the required scope, and cleans up", async () => {
  const fixture = transport();
  assert.deepEqual(await verifyPluginDefaults(fixture.exchange, quiet), {
    templates: 81, accepted: 73, operatorInput: 8,
  });
  assert.equal(fixture.writes.length, 81);
  for (const write of fixture.writes) {
    assert.deepEqual(write.config, getPluginConfigDefault(write.plugin_name));
    assert.equal(write.enabled, true);
    const needsProxy = ["openapi_validator", "tcp_connection_throttle"].includes(write.plugin_name);
    assert.equal(write.scope, needsProxy ? "proxy" : "global");
    assert.equal(Boolean(write.proxy_id), needsProxy);
  }
  assert.equal(fixture.plugins.size, 0);
  assert.equal(fixture.proxies.size, 0);
});

for (const name of Object.keys(OPERATOR_INPUT_REJECTIONS)) {
  test(`${name}: rejects an unrelated 400 instead of hiding unknown-key drift`, async () => {
    const fixture = transport((body) => body.plugin_name === name
      ? { status: 400, body: { error: `${OPERATOR_INPUT_REJECTIONS[name].error}; unknown config key 'drift'` } }
      : undefined);
    await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), /rejection reason drift/);
    assert.equal(fixture.writes.length, 81, "continue through all templates after a failure");
  });

  test(`${name}: unexpected acceptance fails and is cleaned up`, async () => {
    const fixture = transport((body) => body.plugin_name === name ? { status: 201, body } : undefined);
    await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), /expected 400, received 201/);
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
    assert.match(error.message, /correlation_id: expected 201, received 400/);
    assert.match(error.message, /mtls_auth: expected 400, received 503/);
    return true;
  });
  assert.equal(fixture.writes.length, 81);
});

test("gateway catalog drift fails before any submission", async () => {
  const fixture = transport();
  await assert.rejects(verifyPluginDefaults((path, options) => path === "/plugins"
    ? { status: 200, body: Object.keys(DEFAULT_PLUGIN_CONFIGS).filter((name) => name !== "compression") }
    : fixture.exchange(path, options), quiet), /same non-internal catalog/);
  assert.equal(fixture.writes.length, 0);
});

test("a Prometheus registry conflict fails rather than exempting the template", async () => {
  const fixture = transport((body) => body.plugin_name === "prometheus_metrics"
    ? { status: 409, body: { error: "prometheus_metrics permits at most one enabled global instance; another config already owns the process registry" } }
    : undefined);
  await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), /prometheus_metrics: expected 201, received 409/);
  assert.equal(fixture.writes.length, 81);
});

test("Kafka's constructor-error prefix cannot substitute for the egress field-validation error", async () => {
  const fixture = transport((body) => body.plugin_name === "kafka_logging"
    ? { status: 400, body: { error: OPERATOR_INPUT_REJECTIONS.kafka_logging.error.replace("Invalid plugin config fields:", "Invalid plugin config:") } }
    : undefined);
  await assert.rejects(verifyPluginDefaults(fixture.exchange, quiet), /kafka_logging: rejection reason drift/);
  assert.equal(fixture.writes.length, 81);
});

test("cleanup failure fails the gate and stops potentially contaminated submissions", async () => {
  const fixture = transport();
  await assert.rejects(verifyPluginDefaults((path, options) => options?.method === "DELETE"
    ? { status: 503, body: { error: "cleanup unavailable" } }
    : fixture.exchange(path, options), quiet), /cleanup:.*expected 200\/204\/404, received 503/);
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
    assert.match(error.errors[0].message, /expected 201, received 400/);
    assert.match(error.errors[1].message, /cleanup transport failed/);
    return true;
  });
  assert.equal(fixture.writes.length, 1);
  assert.equal(report.pluginDefaults.length, 1);
});
