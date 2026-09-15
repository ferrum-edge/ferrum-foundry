import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { adminToken, expectedBackupFromManifest, readSeedConfig } from "./seed-demo-gateway.mjs";

const config = readSeedConfig();
assert.equal(statSync(config.manifestPath).mode & 0o777, 0o600);
const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8"));
const expected = expectedBackupFromManifest(manifest);
if (manifest.counts) {
  assert.deepEqual(manifest.counts, expected.counts);
}
const token = await adminToken(config);
const response = await fetch(`${config.adminUrl}/backup`, {
  signal: AbortSignal.timeout(30_000),
  headers: {
    authorization: `Bearer ${token}`,
    "x-ferrum-namespace": config.namespace,
  },
});
const text = await response.text();
assert.equal(response.ok, true, `GET /backup failed with ${response.status}: ${text}`);
const backup = JSON.parse(text);

assert.equal(backup.counts.proxies, expected.counts.proxies);
assert.equal(backup.counts.consumers, expected.counts.consumers);
assert.equal(backup.counts.upstreams, expected.counts.upstreams);
assert.equal(backup.counts.plugin_configs, expected.counts.plugin_configs);
assert.equal(backup.proxies.length, expected.counts.proxies);
assert.equal(backup.consumers.length, expected.counts.consumers);
assert.equal(backup.upstreams.length, expected.counts.upstreams);
assert.equal(backup.plugin_configs.length, expected.counts.plugin_configs);
if (expected.omitGlobalPrometheus) {
  assert.equal(expected.prometheus, null);
} else {
  // The catalog probe must release the process-wide Prometheus owner before both
  // seeds. Verify that the known demo fixture now owns it with its exact config.
  assert.ok(expected.prometheus);
  const metrics = backup.plugin_configs.filter((plugin) => (
    plugin.plugin_name === "prometheus_metrics" && plugin.enabled
  ));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].id, expected.prometheus.id);
  assert.equal(metrics[0].scope, "global");
  assert.deepEqual(metrics[0].config, expected.prometheus.config);
}
// Compatible gateway builds may omit an empty API-spec section on export even
// though restore accepts the versioned section. The fixture test asserts the
// request always carries it; when export returns it, verify the exact version.
if (backup.api_specs !== undefined) {
  assert.deepEqual(backup.api_specs, { section_version: "2", items: [] });
}
assert.ok(backup.proxies.every((proxy) => proxy.id && proxy.backend_scheme === "http"));
assert.ok(backup.proxies.every((proxy) => !Object.hasOwn(proxy, "backend_protocol")));
assert.ok(backup.consumers.every((consumer) => (
  Object.values(consumer.credentials).every((entries) => Array.isArray(entries) && entries.length > 0)
)));

console.log(JSON.stringify({
  verified: true,
  namespace: config.namespace,
  counts: backup.counts,
  include_basic_auth: Boolean(manifest.include_basic_auth),
  omit_global_prometheus: Boolean(manifest.omit_global_prometheus),
}));
