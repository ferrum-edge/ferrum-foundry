import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHealth,
  apiSpecByProxyResponse,
  apiSpecListResponse,
  runtimeOverlayResponse,
  crud,
  provisionerFromHeaders,
  READ_ONLY_GATEWAY_MODES,
  readOnlyModeRefusal,
  stampProvisionedBy,
  validatePluginConfigWrite,
  validateProxyWrite,
} from "./mock-admin-gateway.mjs";

const url = new URL("http://127.0.0.1/");
const proxyDefaults = { plugins: [], auth_mode: "single" };

function noneAuthModeBody() {
  return {
    name: "Orders",
    listen_path: "/orders",
    backend_scheme: "https",
    backend_host: "orders.internal",
    backend_port: 8443,
    auth_mode: "none",
  };
}

test("POST /proxies rejects auth_mode none with the Edge unknown-variant body", () => {
  const list = [];
  const [status, payload] = crud(
    list,
    url,
    "POST",
    undefined,
    noneAuthModeBody(),
    proxyDefaults,
    "ferrum",
    validateProxyWrite,
  );
  assert.equal(status, 400);
  assert.deepEqual(payload, {
    error: "Invalid body: unknown variant `none`, expected `single` or `multi`",
  });
  assert.equal(list.length, 0);
});

test("PUT /proxies rejects auth_mode none with the Edge unknown-variant body", () => {
  const list = [{ id: "proxy-1", namespace: "ferrum", auth_mode: "single" }];
  const [status, payload] = crud(
    list,
    url,
    "PUT",
    "proxy-1",
    { ...list[0], auth_mode: "none" },
    proxyDefaults,
    "ferrum",
    validateProxyWrite,
  );
  assert.equal(status, 400);
  assert.equal(
    payload.error,
    "Invalid body: unknown variant `none`, expected `single` or `multi`",
  );
  assert.equal(list[0].auth_mode, "single");
});

test("POST /proxies persists a valid single/multi auth_mode", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { name: "Orders", listen_path: "/orders", auth_mode: "multi" },
    proxyDefaults,
    "ferrum",
    validateProxyWrite,
  );
  assert.equal(status, 201);
  assert.equal(item.auth_mode, "multi");
  assert.equal(list.length, 1);
});

test("POST /plugins/config rejects unknown top-level name", () => {
  const list = [];
  const [status, payload] = crud(
    list,
    url,
    "POST",
    undefined,
    { name: "cors", enabled: true, config: {} },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(status, 400);
  assert.match(payload.error, /^Invalid body: unknown field `name`, expected one of /);
  assert.match(payload.error, /`plugin_name`/);
  assert.match(payload.error, /`scope`/);
  assert.equal(list.length, 0);
});

test("POST /plugins/config requires plugin_name and scope", () => {
  const missingName = crud(
    [],
    url,
    "POST",
    undefined,
    { scope: "global", enabled: true, config: {} },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(missingName[0], 400);
  assert.deepEqual(missingName[1], { error: "Invalid body: missing field `plugin_name`" });

  const missingScope = crud(
    [],
    url,
    "POST",
    undefined,
    { plugin_name: "cors", enabled: true, config: {} },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(missingScope[0], 400);
  assert.deepEqual(missingScope[1], { error: "Invalid body: missing field `scope`" });
});

test("POST /plugins/config stores plugin_name and scope on a valid create", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { plugin_name: "compression", enabled: true, config: {}, scope: "global" },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(status, 201);
  assert.equal(item.plugin_name, "compression");
  assert.equal(item.scope, "global");
  assert.equal(item.enabled, true);
  assert.equal(list[0].plugin_name, "compression");
  assert.equal(list[0].scope, "global");
});

test("PUT /plugins/config rejects unknown name and keeps the stored plugin_name", () => {
  const list = [{
    id: "plg-1",
    namespace: "ferrum",
    plugin_name: "cors",
    scope: "global",
    enabled: true,
    config: {},
  }];
  const [status, payload] = crud(
    list,
    url,
    "PUT",
    "plg-1",
    { name: "cors", enabled: true, config: {} },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(status, 400);
  assert.match(payload.error, /unknown field `name`/);
  assert.equal(list[0].plugin_name, "cors");
});

test("generic crud still accepts other resources without those write hooks", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { username: "mobile-app", credentials: { keyauth: [{ key: "k" }] } },
  );
  assert.equal(status, 201);
  assert.equal(item.username, "mobile-app");
  assert.equal(list.length, 1);
  assert.equal(item.labels, undefined);
});

test("provisionerFromHeaders trims a single header and ignores blanks", () => {
  assert.equal(
    provisionerFromHeaders({ "x-ferrum-provisioned-by": "  ferrum-foundry  " }),
    "ferrum-foundry",
  );
  assert.equal(provisionerFromHeaders({}), null);
  assert.equal(provisionerFromHeaders({ "x-ferrum-provisioned-by": "   " }), null);
  assert.equal(
    provisionerFromHeaders({ "x-ferrum-provisioned-by": ["ferrum-nexus", "other"] }),
    "ferrum-nexus",
  );
});

test("stampProvisionedBy fills absent provisioned-by and keeps an explicit value", () => {
  assert.deepEqual(
    stampProvisionedBy({ team: "platform" }, "ferrum-foundry"),
    { team: "platform", "provisioned-by": "ferrum-foundry" },
  );
  assert.deepEqual(
    stampProvisionedBy({ "provisioned-by": "ferrum-nexus", team: "platform" }, "ferrum-foundry"),
    { "provisioned-by": "ferrum-nexus", team: "platform" },
  );
  assert.deepEqual(stampProvisionedBy({}, null), {});
});

test("POST create records provisioned-by from the header when the body omits it", () => {
  const list = [];
  const provisioner = provisionerFromHeaders({
    "x-ferrum-provisioned-by": "ferrum-foundry",
  });
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { name: "Orders", listen_path: "/orders" },
    proxyDefaults,
    "ferrum",
    validateProxyWrite,
    provisioner,
  );
  assert.equal(status, 201);
  assert.deepEqual(item.labels, { "provisioned-by": "ferrum-foundry" });
  assert.deepEqual(list[0].labels, { "provisioned-by": "ferrum-foundry" });

  const [getStatus, got] = crud(list, url, "GET", item.id);
  assert.equal(getStatus, 200);
  assert.deepEqual(got.labels, { "provisioned-by": "ferrum-foundry" });

  const [listStatus, page] = crud(list, url, "GET");
  assert.equal(listStatus, 200);
  assert.deepEqual(page.data[0].labels, { "provisioned-by": "ferrum-foundry" });
});

test("POST create keeps an explicit provisioned-by over the header and retains other labels", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    {
      username: "mobile-app",
      labels: { "provisioned-by": "ferrum-nexus", team: "platform" },
    },
    {},
    "ferrum",
    undefined,
    "ferrum-foundry",
  );
  assert.equal(status, 201);
  assert.deepEqual(item.labels, {
    "provisioned-by": "ferrum-nexus",
    team: "platform",
  });
});

test("POST create with header fills provisioned-by while retaining other body labels", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { name: "Orders Pool", labels: { team: "platform" } },
    {},
    "ferrum",
    undefined,
    "ferrum-foundry",
  );
  assert.equal(status, 201);
  assert.deepEqual(item.labels, {
    team: "platform",
    "provisioned-by": "ferrum-foundry",
  });
});

test("POST create without header or labels omits the labels key", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { plugin_name: "compression", enabled: true, config: {}, scope: "global" },
    {},
    "ferrum",
    validatePluginConfigWrite,
  );
  assert.equal(status, 201);
  assert.equal(Object.hasOwn(item, "labels"), false);
  assert.equal(Object.hasOwn(list[0], "labels"), false);
});

test("POST create with empty labels and no header omits the labels key", () => {
  const list = [];
  const [status, item] = crud(
    list,
    url,
    "POST",
    undefined,
    { username: "alice", labels: {} },
  );
  assert.equal(status, 201);
  assert.equal(Object.hasOwn(item, "labels"), false);
});

test("PUT does not stamp the header; absent labels preserves the stored map", () => {
  const list = [{
    id: "proxy-1",
    namespace: "ferrum",
    name: "Orders",
    labels: { "provisioned-by": "ferrum-foundry", team: "platform" },
  }];
  const [status, item] = crud(
    list,
    url,
    "PUT",
    "proxy-1",
    { name: "Orders API", auth_mode: "single" },
    proxyDefaults,
    "ferrum",
    validateProxyWrite,
    "ferrum-nexus",
  );
  assert.equal(status, 200);
  assert.equal(item.name, "Orders API");
  assert.deepEqual(item.labels, {
    "provisioned-by": "ferrum-foundry",
    team: "platform",
  });
});

test("PUT with an empty labels map clears labels from the response", () => {
  const list = [{
    id: "upstream-1",
    namespace: "ferrum",
    name: "Orders Pool",
    labels: { "provisioned-by": "ferrum-foundry" },
  }];
  const [status, item] = crud(
    list,
    url,
    "PUT",
    "upstream-1",
    { name: "Orders Pool", labels: {} },
    {},
    "ferrum",
    undefined,
    "ferrum-foundry",
  );
  assert.equal(status, 200);
  assert.equal(Object.hasOwn(item, "labels"), false);
});

test("PUT supplied labels replace the map without filling from the header", () => {
  const list = [{
    id: "plg-1",
    namespace: "ferrum",
    plugin_name: "cors",
    scope: "global",
    enabled: true,
    config: {},
    labels: { "provisioned-by": "ferrum-foundry" },
  }];
  const [status, item] = crud(
    list,
    url,
    "PUT",
    "plg-1",
    {
      plugin_name: "cors",
      scope: "global",
      enabled: true,
      config: {},
      labels: { team: "platform" },
    },
    {},
    "ferrum",
    validatePluginConfigWrite,
    "ferrum-foundry",
  );
  assert.equal(status, 200);
  assert.deepEqual(item.labels, { team: "platform" });
});

test("database mode reports writable admin health and refuses nothing", () => {
  const health = buildHealth("database");
  assert.equal(health.mode, "database");
  assert.equal(health.admin_writes_enabled, true);
  assert.ok(health.database);
  assert.equal(readOnlyModeRefusal("database", "POST", "/proxies"), null);
});

test("file mode reports a read-only admin API with no configured database", () => {
  const health = buildHealth("file");
  assert.equal(health.mode, "file");
  assert.equal(health.admin_writes_enabled, false);
  assert.equal(health.database, undefined);
});

for (const mode of ["file", "dp", "mesh"]) {
  test(`${mode} mode refuses persisted configuration mutations`, () => {
    for (const [method, path] of [
      ["POST", "/proxies"],
      ["PUT", "/proxies/proxy-1"],
      ["DELETE", "/upstreams/upstream-1"],
      ["POST", "/consumers"],
      ["PUT", "/plugins/config/plg-1"],
      ["POST", "/api-specs"],
      ["POST", "/namespaces"],
      ["POST", "/gateway-trust-bundles"],
      ["POST", "/batch"],
      ["POST", "/restore"],
    ]) {
      assert.deepEqual(
        readOnlyModeRefusal(mode, method, path),
        [403, { error: "Admin API is in read-only mode" }],
        `${method} ${path}`,
      );
    }
  });

  test(`${mode} mode refuses managed TLS and ACME material writes`, () => {
    // `admit_non_config_db_write` applies the read-only gate to the independent
    // TLS/ACME stores even though `admin_writes_enabled` does not cover them.
    for (const [method, path] of [
      ["POST", "/admin/tls/certificates"],
      ["PUT", "/admin/tls/certificates/cert-1"],
      ["DELETE", "/admin/tls/ca-bundles/bundle-1"],
      ["POST", "/admin/tls/crls"],
      ["POST", "/admin/tls/ocsp-responses"],
      ["POST", "/admin/tls/jwks"],
      ["POST", "/admin/tls/acme/orders"],
      ["POST", "/admin/tls/acme/orders/order-1/finalize"],
      ["POST", "/admin/tls/acme/renew/cert-1"],
      ["DELETE", "/admin/tls/acme/certificates/cert-1"],
    ]) {
      assert.deepEqual(
        readOnlyModeRefusal(mode, method, path),
        [403, { error: "Admin API is in read-only mode" }],
        `${method} ${path}`,
      );
    }
  });

  test(`${mode} mode still serves reads and non-persisting operations`, () => {
    assert.equal(readOnlyModeRefusal(mode, "GET", "/proxies"), null);
    assert.equal(readOnlyModeRefusal(mode, "GET", "/admin/tls/certificates"), null);
    // `admit_audited_operation` does not apply the read-only gate.
    assert.equal(readOnlyModeRefusal(mode, "POST", "/admin/tls/validate"), null);
    assert.equal(readOnlyModeRefusal(mode, "POST", "/admin/tls/rotate/proxy_https"), null);
    assert.equal(readOnlyModeRefusal(mode, "POST", "/mesh/egress-scope/test"), null);
    assert.equal(readOnlyModeRefusal(mode, "POST", "/backend-capabilities/refresh"), null);
  });
}

test("node_agent is a read-only mode upstream", () => {
  // `src/modes/node_agent.rs` reports `mode: "node_agent"` with
  // `read_only: true`, so it belongs to the same refusal set.
  assert.equal(READ_ONLY_GATEWAY_MODES.has("node_agent"), true);
  assert.deepEqual(readOnlyModeRefusal("node_agent", "POST", "/proxies"), [
    403,
    { error: "Admin API is in read-only mode" },
  ]);
});


test("API spec binding metadata and raw lookup share namespace isolation", () => {
  const specs = [
    { id: 'spec-a', proxy_id: 'shared', namespace: 'a', content_encoding: 'gzip' },
    { id: 'spec-b', proxy_id: 'shared', namespace: 'b', content_encoding: 'gzip' },
  ];
  const query = new URL('http://localhost/api-specs?proxy_id=shared&limit=2&offset=0');
  assert.deepEqual(apiSpecListResponse(specs, query, 'a'), {
    items: [{ id: 'spec-a', proxy_id: 'shared' }], total: 1, limit: 2, offset: 0, next_offset: null,
  });
  assert.deepEqual(apiSpecByProxyResponse(specs, { 'spec-a': 'openapi: 3.1.0' }, 'a', 'shared'),
    [200, 'openapi: 3.1.0', 'application/yaml']);
  assert.deepEqual(apiSpecByProxyResponse(specs, {}, 'c', 'shared'),
    [404, { error: 'API spec not found' }, 'application/json']);
});

test("runtime overlay distinguishes mesh accepted state from no active overlay", () => {
  assert.equal(runtimeOverlayResponse('mesh')[0], 200);
  assert.equal(runtimeOverlayResponse('mesh')[1].runtime_overlay.fields['ferrum.log.level'].kind, 'string');
  assert.deepEqual(runtimeOverlayResponse('database'), [404, { error: 'No active mesh runtime overlay' }]);
});

test("detailed mock health carries conditional diagnostics and namespace serving scope", () => {
  const db = buildHealth('database');
  assert.equal(db.namespace.serving_scope, 'single-namespace-data-plane');
  assert.equal(db.database_polling.status, 'ok');
  assert.equal('audit_pipeline' in db, false);
  assert.equal(db.logging.stdout, null);
  assert.equal('database_polling' in buildHealth('mesh'), false);
  assert.equal(buildHealth('cp').namespace.active, null);
});
