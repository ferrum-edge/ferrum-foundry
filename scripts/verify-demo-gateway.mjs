import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { adminToken, readSeedConfig } from "./seed-demo-gateway.mjs";

const config = readSeedConfig();
assert.equal(statSync(config.manifestPath).mode & 0o777, 0o600);
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

assert.equal(backup.counts.proxies, 18);
assert.equal(backup.counts.consumers, 18);
assert.equal(backup.counts.upstreams, 18);
assert.equal(backup.proxies.length, 18);
assert.equal(backup.consumers.length, 18);
assert.equal(backup.upstreams.length, 18);
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
}));
