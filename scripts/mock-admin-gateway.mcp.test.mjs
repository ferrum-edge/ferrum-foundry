/* ------------------------------------------------------------------ */
/*  End to end against the mock admin gateway: the MCP tool catalog    */
/*  (`GET /proxies/{id}/mcp/tools`, Ferrum Edge v0.9.9) and a per-tool */
/*  policy edit written back through the conditional-write path, the  */
/*  same sequence Foundry's Tools panel sends: read the plugin         */
/*  configuration with its ETag, PUT it with only one policy.tools     */
/*  entry changed and If-Match set to that ETag, read the catalog.     */
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  MOCK_UPSTREAM_MCP_TOOLS,
  mcpToolCatalogResponse,
  server,
  validateMcpGatewayPolicy,
} from "./mock-admin-gateway.mjs";

const PROXY = "proxy-agent-tools";
const PLUGIN = "plg-mcp-gateway";
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

function request(path, { method = "GET", namespace = "ferrum", body, headers = {} } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "x-ferrum-namespace": namespace,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function catalog(proxyId = PROXY, namespace = "ferrum") {
  const response = await request(`/proxies/${proxyId}/mcp/tools?offset=0&limit=1000`, { namespace });
  return { status: response.status, body: await response.json() };
}

function tool(body, name) {
  const found = body.data.find((entry) => entry.name === name);
  assert.ok(found, `catalog lists ${name}`);
  return found;
}

/** Foundry's `toUpdatePayload` minus `labels`, which Edge preserves when omitted. */
function replacePayload(stored) {
  const payload = { ...stored };
  for (const key of ["created_at", "updated_at", "namespace", "api_spec_id", "labels"]) delete payload[key];
  return payload;
}

async function readPlugin() {
  const response = await request(`/plugins/config/${PLUGIN}`);
  assert.equal(response.status, 200);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]+"$/);
  return { plugin: await response.json(), etag };
}

test("the catalog follows the v0.9.9 response shape", async () => {
  const { status, body } = await catalog();
  assert.equal(status, 200);
  assert.equal(body.proxy_id, PROXY);
  assert.equal(body.namespace, "ferrum");
  assert.equal(body.stale, false);
  assert.equal(typeof body.refreshed_at, "string");
  assert.deepEqual(body.pagination, { offset: 0, limit: 1000, total: 4 });
  assert.equal(body.catalogs.length, 1);

  const [instance] = body.catalogs;
  assert.equal(instance.plugin_config_id, PLUGIN);
  assert.equal(instance.catalog_state, "fresh");
  assert.equal(instance.mode, "aggregate_router");
  assert.equal(instance.endpoint_path, "/mcp");
  assert.deepEqual(instance.policy, { default_action: "deny", hide_denied_tools: true });
  assert.deepEqual(instance.discovery, { on_new_tool: "hide_until_configured", on_schema_change: "hide_until_configured" });
  const github = instance.servers.find((entry) => entry.server_id === "github");
  // Structural projection only: the path, which may carry a token, is masked.
  assert.equal(github.upstream_url, "https://mcp-github.internal.example.com/[REDACTED_PATH]");
  assert.equal(github.kind, "mcp");
  assert.equal(github.refresh_error, null);
  const orders = instance.servers.find((entry) => entry.server_id === "orders");
  assert.equal(orders.kind, "openapi");
  assert.equal(orders.upstream_url, null);

  assert.deepEqual(body.data.map((entry) => entry.name), [
    "github.create_issue",
    "github.search_issues",
    "orders.cancel_order",
    "orders.list_orders",
  ]);
  const search = tool(body, "github.search_issues");
  assert.deepEqual(search.source, {
    type: "upstream", server_id: "github", namespace: "github", upstream_name: "search_issues",
  });
  assert.deepEqual(search.policy, {
    action: "allow", configured: true, effective: "allow", listed: true, callable: true,
  });
  assert.equal(search.allowed_groups, null);
  assert.deepEqual(search.denied_groups, []);
  assert.match(search.schema_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(search.annotations, { readOnlyHint: true });

  // Not named in policy.tools under on_new_tool: hide_until_configured.
  assert.equal(tool(body, "github.create_issue").policy.effective, "hidden_until_configured");

  const list = tool(body, "orders.list_orders");
  assert.deepEqual(list.source, {
    type: "openapi", server_id: "orders", namespace: "orders",
    operation_name: "list_orders", method: "GET", path: "/agents/orders",
  });
  assert.deepEqual(list.allowed_groups, ["support"]);
  assert.equal(tool(body, "orders.cancel_order").policy.effective, "deny");
  assert.equal(tool(body, "orders.cancel_order").policy.listed, false);
});

test("a per-tool grant round-trips through If-Match and shows in the next catalog read", async () => {
  const { plugin, etag } = await readPlugin();
  const payload = replacePayload(plugin);
  payload.config.policy.tools["github.create_issue"] = {
    action: "allow",
    allowed_groups: ["platform", "eng"],
    denied_groups: ["contractors"],
  };

  const write = await request(`/plugins/config/${PLUGIN}`, {
    method: "PUT", body: payload, headers: { "if-match": etag },
  });
  assert.equal(write.status, 200);
  const stored = await write.json();
  // Omitted labels are preserved: the provisioner's attribution survives.
  assert.deepEqual(stored.labels, { "provisioned-by": "ferrum-nexus" });
  // Every other entry, and their order, is untouched.
  assert.deepEqual(Object.keys(stored.config.policy.tools), [
    "github.search_issues",
    "orders.list_orders",
    "orders.cancel_order",
    "github.create_issue",
  ]);

  const { body } = await catalog();
  const created = tool(body, "github.create_issue");
  assert.deepEqual(created.policy, {
    action: "allow", configured: true, effective: "allow", listed: true, callable: true,
  });
  // Edge reports grants sorted.
  assert.deepEqual(created.allowed_groups, ["eng", "platform"]);
  assert.deepEqual(created.denied_groups, ["contractors"]);

  // The tag the edit was sent against is spent: replaying it is refused and
  // writes nothing.
  payload.config.policy.tools["github.create_issue"] = { action: "deny" };
  const stale = await request(`/plugins/config/${PLUGIN}`, {
    method: "PUT", body: payload, headers: { "if-match": etag },
  });
  assert.equal(stale.status, 412);
  assert.equal(tool((await catalog()).body, "github.create_issue").policy.action, "allow");
});

test("removing an entry hands the tool back to the default action", async () => {
  const { plugin, etag } = await readPlugin();
  const payload = replacePayload(plugin);
  delete payload.config.policy.tools["orders.cancel_order"];
  const write = await request(`/plugins/config/${PLUGIN}`, {
    method: "PUT", body: payload, headers: { "if-match": etag },
  });
  assert.equal(write.status, 200);
  const cancel = tool((await catalog()).body, "orders.cancel_order");
  assert.equal(cancel.policy.configured, false);
  assert.equal(cancel.policy.action, "deny");
  assert.equal(cancel.policy.effective, "hidden_until_configured");
});

test("a grant on a non-allow entry is refused and nothing is written", async () => {
  const { plugin, etag } = await readPlugin();
  const payload = replacePayload(plugin);
  payload.config.policy.tools["github.search_issues"] = { action: "deny", allowed_groups: ["eng"] };
  const write = await request(`/plugins/config/${PLUGIN}`, {
    method: "PUT", body: payload, headers: { "if-match": etag },
  });
  assert.equal(write.status, 400);
  assert.equal(tool((await catalog()).body, "github.search_issues").policy.action, "allow");
  const reread = await readPlugin();
  assert.equal(reread.etag, etag);
});

test("the catalog answers the documented 404s, and only GET", async () => {
  const plain = await catalog("proxy-orders-api");
  assert.equal(plain.status, 404);
  assert.deepEqual(plain.body, { error: "Proxy has no mcp_gateway plugin" });

  const missing = await catalog("proxy-missing");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "Proxy not found" });

  // Namespace-scoped like GET /proxies/{id}: another namespace's proxy is 404.
  const elsewhere = await catalog(PROXY, "tenant-b");
  assert.equal(elsewhere.status, 404);
  assert.deepEqual(elsewhere.body, { error: "Proxy not found" });

  const write = await request(`/proxies/${PROXY}/mcp/tools`, { method: "POST", body: {} });
  assert.equal(write.status, 405);
});

const fixtureProxy = { id: "agents", namespace: "ferrum", plugins: [{ plugin_config_id: "mcp" }] };
const fixturePlugin = {
  id: "mcp", namespace: "ferrum", plugin_name: "mcp_gateway", scope: "proxy", proxy_id: "agents", enabled: true,
  config: {
    mode: "aggregate_router",
    endpoint: { path: "/mcp" },
    servers: { github: { upstream_url: "https://mcp.example.com/mcp", namespace: "github" } },
  },
};
const url = new URL("http://127.0.0.1/?limit=100");

test("the catalog is node-local: a control plane reports not_served with no tools", () => {
  const [status, body] = mcpToolCatalogResponse({
    proxies: [fixtureProxy], pluginConfigs: [fixturePlugin], mode: "cp",
    namespace: "ferrum", proxyId: "agents", url, discovered: MOCK_UPSTREAM_MCP_TOOLS,
  });
  assert.equal(status, 200);
  assert.deepEqual(body.catalogs, [{
    plugin_config_id: "mcp", catalog_state: "not_served", refreshed_at: null,
    stale: true, tool_count: 0, servers: [],
  }]);
  assert.deepEqual(body.data, []);
  assert.equal(body.refreshed_at, null);
  assert.equal(body.stale, true);
});

test("a node that does not serve the namespace reports not_served", () => {
  const proxy = { ...fixtureProxy, namespace: "tenant-b" };
  const plugin = { ...fixturePlugin, namespace: "tenant-b" };
  const [, body] = mcpToolCatalogResponse({
    proxies: [proxy], pluginConfigs: [plugin], mode: "dp",
    namespace: "tenant-b", proxyId: "agents", url,
  });
  assert.equal(body.catalogs[0].catalog_state, "not_served");
});

test("a transparent_proxy instance is unmediated, and a global instance applies when none is associated", () => {
  const global = {
    ...fixturePlugin, id: "global-mcp", scope: "global", proxy_id: null,
    config: { mode: "transparent_proxy", endpoint: { path: "/mcp" }, servers: fixturePlugin.config.servers },
  };
  const [status, body] = mcpToolCatalogResponse({
    proxies: [{ ...fixtureProxy, plugins: [] }], pluginConfigs: [global], mode: "database",
    namespace: "ferrum", proxyId: "agents", url,
  });
  assert.equal(status, 200);
  assert.equal(body.catalogs[0].plugin_config_id, "global-mcp");
  assert.equal(body.catalogs[0].catalog_state, "unmediated");
  assert.deepEqual(body.data, []);
});

test("bridge tools whose method the proxy does not allow are neither listed nor callable", () => {
  const plugin = {
    ...fixturePlugin,
    config: {
      ...fixturePlugin.config,
      servers: { api: { namespace: "api", openapi: { operations: [{ name: "drop", method: "DELETE", path: "/x" }] } } },
      policy: { tools: { "api.drop": { action: "allow" } } },
    },
  };
  const [, body] = mcpToolCatalogResponse({
    proxies: [{ ...fixtureProxy, allowed_methods: ["GET", "POST"] }], pluginConfigs: [plugin],
    mode: "database", namespace: "ferrum", proxyId: "agents", url,
  });
  assert.deepEqual(body.data[0].policy, {
    action: "allow", configured: true, effective: "allow", listed: false, callable: false,
  });
  assert.deepEqual(body.data[0].annotations, { destructiveHint: true });
});

test("the mock refuses the policy.tools shapes Edge refuses", () => {
  const config = (tools, mode = "aggregate_router") => ({ mode, policy: { tools } });
  assert.equal(validateMcpGatewayPolicy(config({ "a.b": { action: "allow", allowed_groups: ["x"] } })), null);
  assert.equal(validateMcpGatewayPolicy({ mode: "transparent_proxy" }), null);
  for (const refused of [
    config({ "a.b": { action: "allow" } }, "transparent_proxy"),
    config({ "a.b": { action: "maybe" } }),
    config({ "a.b": { action: "deny", denied_groups: ["x"] } }),
    config({ "a.b": { action: "allow", allowed_groups: [] } }),
    config({ "a.b": { action: "allow", allowed_groups: ["x"], denied_groups: ["x"] } }),
    config({ "a.b": { action: "allow", groups: ["x"] } }),
  ]) {
    assert.match(validateMcpGatewayPolicy(refused).error, /^Invalid mcp_gateway config: /);
  }
});
