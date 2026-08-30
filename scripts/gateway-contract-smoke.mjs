import assert from "node:assert/strict";
import { adminToken, buildRestorePayload, readSeedConfig } from "./seed-demo-gateway.mjs";

const config = readSeedConfig();

async function request(path, { method = "GET", body, expected = [200, 201] } = {}) {
  const token = await adminToken(config);
  const response = await fetch(`${config.adminUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-ferrum-namespace": config.namespace,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(
    expected.includes(response.status),
    `${method} ${path} returned ${response.status}: ${text}`,
  );
  const cursor = response.headers.get("x-ferrum-config-cursor");
  if (cursor !== null) assert.match(cursor, /^\d+:\d+$/);
  return text ? JSON.parse(text) : undefined;
}

const fixture = buildRestorePayload("2026-08-30T00:00:00.000Z");
const upstreamId = "contract-smoke-upstream";
const consumerId = "contract-smoke-consumer";
const proxyId = "contract-smoke-proxy";
const pluginId = "contract-smoke-plugin";

const { created_at: _upstreamCreated, updated_at: _upstreamUpdated, ...upstreamTemplate } = fixture.upstreams[0];
const upstream = {
  ...upstreamTemplate,
  id: upstreamId,
  name: "Contract smoke upstream",
};
const consumer = {
  id: consumerId,
  username: "contract-smoke-consumer",
  custom_id: "contract-smoke-custom-id",
  credentials: { keyauth: [{ key: "contract-smoke-api-key-primary" }] },
  acl_groups: ["contract-smoke"],
};
const {
  created_at: _proxyCreated,
  updated_at: _proxyUpdated,
  ...proxyTemplate
} = fixture.proxies.find((proxy) => proxy.id === "demo-proxy-sandbox");
const proxy = {
  ...proxyTemplate,
  id: proxyId,
  name: "Contract smoke proxy",
  listen_path: "/contract-smoke",
  upstream_id: upstreamId,
  plugins: [],
};
const plugin = {
  id: pluginId,
  plugin_name: "request_size_limiting",
  scope: "proxy",
  proxy_id: proxyId,
  enabled: false,
  config: { max_bytes: 4096 },
};

void _upstreamCreated;
void _upstreamUpdated;
void _proxyCreated;
void _proxyUpdated;

await request("/upstreams?apply=sync", { method: "POST", body: upstream });
await request(`/upstreams/${upstreamId}?apply=sync`, {
  method: "PUT",
  body: { ...upstream, name: "Contract smoke upstream updated" },
});

await request("/consumers?apply=sync", { method: "POST", body: consumer });
await request(`/consumers/${consumerId}?apply=sync`, {
  method: "PUT",
  body: { ...consumer, custom_id: "contract-smoke-custom-id-updated" },
});
const rotated = await request(`/consumers/${consumerId}/credentials/keyauth?apply=sync`, {
  method: "POST",
  body: { key: "contract-smoke-api-key-rotated" },
});
assert.equal(rotated.credentials.keyauth.length, 2);
await request(`/consumers/${consumerId}/credentials/keyauth/1?apply=sync`, {
  method: "DELETE",
  expected: [200, 204],
});

await request("/proxies?apply=sync", { method: "POST", body: proxy });
await request(`/proxies/${proxyId}?apply=sync`, {
  method: "PUT",
  body: { ...proxy, name: "Contract smoke proxy updated" },
});

await request("/plugins/config?apply=sync", { method: "POST", body: plugin });
await request(`/plugins/config/${pluginId}?apply=sync`, {
  method: "PUT",
  body: { ...plugin, config: { max_bytes: 8192 } },
});

for (const endpoint of ["upstreams", "consumers", "proxies", "plugins/config"]) {
  const page = await request(`/${endpoint}?offset=0&limit=20`);
  assert.ok(Array.isArray(page.data));
  assert.ok(Number.isSafeInteger(page.pagination.total));
}
const namespaces = await request("/namespaces?offset=0&limit=100");
const namespaceNames = Array.isArray(namespaces) ? namespaces : namespaces.data;
assert.ok(namespaceNames.includes(config.namespace));

await request(`/plugins/config/${pluginId}?apply=sync`, { method: "DELETE", expected: [200, 204] });
await request(`/proxies/${proxyId}?apply=sync&cleanup_orphaned_upstream=false`, {
  method: "DELETE",
  expected: [200, 204],
});
await request(`/consumers/${consumerId}?apply=sync`, { method: "DELETE", expected: [200, 204] });
// Older compatible gateways always clean the last-referenced upstream when a
// proxy is deleted; current gateways honor cleanup_orphaned_upstream=false.
await request(`/upstreams/${upstreamId}?apply=sync`, { method: "DELETE", expected: [200, 204, 404] });

console.log(JSON.stringify({
  verified: true,
  operations: ["read", "create", "full-replace update", "credential rotation", "delete"],
  resources: ["upstreams", "consumers", "proxies", "plugin configs", "namespaces"],
}));
