import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BFF_ONLY_SURFACES,
  PROBE_ID,
  READ_PROBES,
  WRITE_PROBES,
  classifyDenial,
  confirmWritableParityTarget,
  gatewaySender,
  verifyCapabilityParity,
} from "./capability-parity-contract.mjs";

const RANK = { viewer: 0, operator: 1, admin: 2 };

/**
 * An independent transcription of the pinned ferrum-edge release's (v0.9.7;
 * identical in v0.9.5 and the earlier b96cfaa build) route roles
 * (`require_admin_role` in each `src/admin/mod.rs` arm) and the admission
 * function each handler calls first — not derived from the probe table or the
 * capability model it is checking.
 */
const EDGE_ROUTES = [
  { method: "DELETE", prefix: "/proxies/", role: "operator", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/upstreams/", role: "operator", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/plugins/config/", role: "operator", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/consumers/", role: "admin", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/api-specs/", role: "admin", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/namespaces/", role: "admin", gate: "config-store", ok: 404 },
  { method: "DELETE", prefix: "/gateway-trust-bundles/", role: "admin", gate: "config-store", ok: 404 },
  { method: "POST", prefix: "/restore", role: "admin", gate: "config-store", ok: 400 },
  { method: "GET", prefix: "/backup", role: "admin", gate: "none", ok: 200 },
  { method: "DELETE", prefix: "/admin/tls/certificates/", role: "admin", gate: "read-only-mode", ok: 404 },
  { method: "POST", prefix: "/admin/tls/validate", role: "operator", gate: "none", ok: 400 },
  { method: "GET", prefix: "/admin/tls/inventory", role: "operator", gate: "none", ok: 200 },
  { method: "GET", prefix: "/gateway-trust-bundles", role: "operator", gate: "none", ok: 200, collection: true },
  { method: "GET", prefix: "/audit", role: "admin", gate: "none", ok: 200 },
  { method: "GET", prefix: "/proxies", role: "viewer", gate: "none", ok: 200, collection: true },
  { method: "GET", prefix: "/upstreams", role: "viewer", gate: "none", ok: 200, collection: true },
  { method: "GET", prefix: "/consumers", role: "viewer", gate: "none", ok: 200, collection: true },
  { method: "GET", prefix: "/plugins/config", role: "viewer", gate: "none", ok: 200, collection: true },
  { method: "GET", prefix: "/namespaces", role: "viewer", gate: "none", ok: 200, collection: true },
];

function fakeGateway({ readOnly = false, override = () => undefined } = {}) {
  const requests = [];
  const send = async (role, request) => {
    requests.push({ role, ...request });
    if (request.path === "/health") {
      return {
        status: 200,
        body: { status: "ok", mode: "database", admin_writes_enabled: !readOnly },
      };
    }
    const rule = EDGE_ROUTES
      .filter((entry) => entry.method === request.method && request.path.startsWith(entry.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    assert.ok(rule, `unmodelled request ${request.method} ${request.path}`);
    const forced = override(role, request, rule);
    if (forced) return forced;
    if (RANK[role] < RANK[rule.role]) {
      return {
        status: 403,
        body: {
          error: `Admin role '${role}' cannot access this endpoint; required role is '${rule.role}'`,
        },
      };
    }
    if (readOnly && rule.gate !== "none") {
      return { status: 403, body: { error: "Admin API is in read-only mode" } };
    }
    return {
      status: rule.ok,
      body: rule.collection ? { data: [], pagination: { offset: 0, limit: 1, total: 0 } } : {},
    };
  };
  return { send, requests };
}

describe("capability parity contract", () => {
  it("agrees with a writable gateway for every role", async () => {
    const { send } = fakeGateway();
    const result = await verifyCapabilityParity(send, { expectation: "writable" });
    assert.equal(result.writes.viewer.proxies, 403);
    assert.equal(result.writes.operator.proxies, 404);
    assert.equal(result.writes.operator.consumers, 403);
    assert.equal(result.writes.admin.configBackup, 400);
    assert.equal(result.reads.viewer.proxies, 200);
    assert.equal(result.reads.viewer["TLS inventory"], 403);
  });

  it("agrees with a gateway started with FERRUM_ADMIN_READ_ONLY", async () => {
    const { send } = fakeGateway({ readOnly: true });
    const result = await verifyCapabilityParity(send, { expectation: "read-only" });
    assert.deepEqual(result.observed, { mode: "database", adminWritesEnabled: false, status: "ok" });
    assert.equal(result.writes.admin.proxies, 403);
    assert.equal(result.writes.admin.tlsMaterial, 403);
    // Rotate/validate and export are not behind the read-only gate.
    assert.equal(result.writes.operator.operationalActions, 400);
    assert.equal(result.writes.admin.configExport, 200);
  });

  it("refuses to pass against a gateway in the wrong mode", async () => {
    await assert.rejects(
      verifyCapabilityParity(fakeGateway().send, { expectation: "read-only" }),
      /expected a read-only gateway/,
    );
    await assert.rejects(
      verifyCapabilityParity(fakeGateway({ readOnly: true }).send, { expectation: "writable" }),
      /expected a writable gateway/,
    );
    await assert.rejects(verifyCapabilityParity(fakeGateway().send, {}), /expectation must be/);
  });

  it("fails when the gateway requires a different role than the model", async () => {
    const { send } = fakeGateway({
      override: (role, request) => request.method === "DELETE" && request.path.startsWith("/proxies/")
        && role === "operator"
        ? { status: 403, body: { error: "Admin role 'operator' cannot access this endpoint; required role is 'admin'" } }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(send, { expectation: "writable" }),
      /operator proxies .*model expects admitted, gateway answered role denial requiring admin/,
    );
  });

  it("fails when the gateway gates a surface the model treats as ungated", async () => {
    const { send } = fakeGateway({
      readOnly: true,
      override: (role, request) => request.path === "/admin/tls/validate" && role !== "viewer"
        ? { status: 403, body: { error: "Admin API is in read-only mode" } }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(send, { expectation: "read-only" }),
      /operationalActions .*model expects admitted, gateway answered read-only denial/,
    );
  });

  it("fails when a withheld read looks like a missing feature instead of a denial", async () => {
    const { send } = fakeGateway({
      override: (role, request) => request.path.startsWith("/audit") && role !== "admin"
        ? { status: 404, body: { error: "not found" } }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(send, { expectation: "writable" }),
      /read of audit log: expected an explicit 403 requiring admin/,
    );
  });

  it("fails when a launch collection is refused or empty-bodied for a permitted role", async () => {
    const refused = fakeGateway({
      override: (role, request) => role === "viewer" && request.path.startsWith("/proxies?")
        ? { status: 403, body: { error: "Namespace access denied" } }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(refused.send, { expectation: "writable" }),
      /viewer read of proxies was refused \(403\)/,
    );
    const shapeless = fakeGateway({
      override: (role, request) => request.path.startsWith("/upstreams?")
        ? { status: 200, body: {} }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(shapeless.send, { expectation: "writable" }),
      /read of upstreams returned 200 without a collection/,
    );
  });

  it("treats an authentication failure as a failed probe, not a denial", async () => {
    const { send } = fakeGateway({
      override: (role, request) => request.method !== "GET" && role === "admin"
        ? { status: 401, body: { error: "Unauthorized" } }
        : undefined,
    });
    await assert.rejects(verifyCapabilityParity(send, { expectation: "writable" }), /gateway answered 401: authentication failed/);
  });

  it("fails if an admitted delete finds and removes the reserved probe id", async () => {
    const { send } = fakeGateway({
      override: (role, request) => role === "operator" && request.path === `/proxies/${PROBE_ID}`
        ? { status: 204, body: undefined }
        : undefined,
    });
    await assert.rejects(
      verifyCapabilityParity(send, { expectation: "writable" }),
      /operator proxies .*gateway answered admitted \(204\)/,
    );
  });

  it("requires exact destructive-target confirmation for writable execution", () => {
    const config = {
      adminUrl: "https://gateway.example",
      namespace: "tenant-a",
      destructiveConfirmation: undefined,
    };
    assert.throws(
      () => confirmWritableParityTarget(config, "writable"),
      /FERRUM_DEMO_CONFIRM_TARGET must exactly equal "https:\/\/gateway\.example#tenant-a"/,
    );
    config.destructiveConfirmation = "https://gateway.example#tenant-a";
    assert.doesNotThrow(() => confirmWritableParityTarget(config, "writable"));
    config.destructiveConfirmation = undefined;
    assert.doesNotThrow(() => confirmWritableParityTarget(config, "read-only"));
  });

  it("defines safe expected outcomes for every gateway-backed surface", () => {
    assert.ok(BFF_ONLY_SURFACES.has("bffSettings"));
    assert.equal(Object.hasOwn(WRITE_PROBES, "bffSettings"), false);
    for (const [surface, probe] of Object.entries(WRITE_PROBES)) {
      if (probe.method === "DELETE") {
        assert.ok(probe.path.includes(PROBE_ID), `${surface} must delete only the probe id`);
        assert.equal(probe.admittedStatus, 404, `${surface} must require a missing probe id`);
      } else if (probe.method === "POST") {
        assert.ok(["/restore", "/admin/tls/validate"].includes(probe.path), `${surface} POST`);
      } else {
        assert.equal(probe.method, "GET", surface);
      }
      assert.equal(probe.path.includes("confirm=true"), false, `${surface} must never confirm`);
    }
    assert.throws(() => JSON.parse(WRITE_PROBES.configBackup.rawBody));
    assert.ok(READ_PROBES.every((probe) => !probe.path.includes(PROBE_ID)));
  });

  it("classifies only the gateway's own 403 bodies", () => {
    assert.deepEqual(
      classifyDenial({ status: 403, body: { error: "Admin role 'viewer' cannot access this endpoint; required role is 'operator'" } }),
      { kind: "role", requiredRole: "operator" },
    );
    assert.deepEqual(
      classifyDenial({ status: 403, body: { error: "Admin API is in read-only mode" } }),
      { kind: "gateway-read-only" },
    );
    assert.deepEqual(
      classifyDenial({ status: 403, body: { error: "Namespace access denied" } }),
      { kind: "other", message: "Namespace access denied" },
    );
    assert.equal(classifyDenial({ status: 404, body: { error: "read-only mode" } }), null);
  });

  it("signs each probe as the requested role for the namespace under test", async () => {
    const seen = [];
    const send = gatewaySender({
      adminUrl: "http://gateway.test:9000",
      jwtSecret: "capability-parity-test-secret-at-least-32-characters",
      jwtIssuer: "ferrum-edge",
      jwtAudience: "ferrum-admin",
      namespace: "tenant-a",
    }, {
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const response = await send("operator", WRITE_PROBES.configBackup);
    assert.deepEqual(response, { status: 200, body: { ok: true } });
    const [{ url, init }] = seen;
    assert.equal(url, "http://gateway.test:9000/restore");
    assert.equal(init.method, "POST");
    assert.equal(init.body, "{");
    assert.equal(init.headers["x-ferrum-namespace"], "tenant-a");
    const claims = JSON.parse(
      Buffer.from(init.headers.authorization.split(".")[1], "base64url").toString("utf8"),
    );
    assert.equal(claims.role, "operator");
    assert.deepEqual(claims.ns, ["tenant-a", PROBE_ID]);
    assert.equal(claims.aud, "ferrum-admin");
  });
});
