import assert from "node:assert/strict";
import test from "node:test";
import {
  crud,
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
});
