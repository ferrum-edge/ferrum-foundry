/* ------------------------------------------------------------------ */
/*  Role x mode capability parity against a real gateway (issue #385)  */
/* ------------------------------------------------------------------ */

/**
 * Foundry's client-side capability model (`src/lib/capabilities.ts`) mirrors
 * Ferrum Edge's authorization matrix by hand (`docs/capabilities.md` →
 * "Drift"). This contract asks the pinned gateway the same questions the model
 * answers, as each of `viewer`, `operator`, and `admin`, and fails on any
 * disagreement:
 *
 * - The model says a surface is **allowed** and the gateway refuses it with
 *   `403`: the UI would offer a form whose only outcome is a denial.
 * - The model says **role**-denied and the gateway admits the request, or
 *   names a different required role: the UI hides a permitted capability, or
 *   explains the denial wrongly.
 * - The model says **read-only**-denied and the gateway does not refuse the
 *   write as read-only.
 *
 * Reads are checked the same way, for the reason the issue gives: an ordinary
 * denial must not look like missing data. Every role must get real
 * collections for the launch surfaces, and a read the gateway withholds from a
 * role must come back as an explicit `403` naming the role — never as a
 * `404`/`501`/`503`, which Foundry presents as "not enabled on this gateway".
 *
 * The destructive-target confirmation is mandatory before writable probes,
 * because the `DELETE` probes are safe only when their reserved id does not
 * exist. The contract also requires those admitted deletes to return `404`,
 * rather than treating a successful deletion as parity. The remaining probes
 * are `POST /admin/tls/validate` (non-persistent), a `POST /admin/tls/rotate`
 * for a surface Edge does not support (refused with `400` after the role check
 * and audit admission, so nothing is reloaded; with
 * `FERRUM_ADMIN_AUDIT_ENABLED=true` that admission records a durable audit
 * intent finalized as a refused rotate, as the `DELETE` probes do for theirs),
 * a mesh egress dry-run (`404` on a gateway without a mesh egress scope),
 * `GET /backup`, or a `POST /restore` without `?confirm=true` and with a body
 * that is not JSON. Each still passes through exactly the role check and the
 * admission gate the surface mirrors, because Edge applies both before it
 * looks the resource up (ferrum-edge v0.9.15, the pinned release, and every
 * earlier pinned release back to the b96cfaa build alike:
 * `crud::handle_delete`, `handle_restore`,
 * `tls_management::handle_delete_managed`).
 *
 * `POST /restore` is the one exception to that order. `handle_restore` calls
 * `require_db` *before* `admit_write`, so a `file` or `dp` gateway (no
 * configuration database) answers the documented
 * `503 {"error":"No database"}` instead of the read-only `403` the other
 * config-store writes return. That typed `503` is a no-writable-store
 * precondition — the restore never ran — not an admission. Under a read-only
 * expectation the contract accepts it as an expected read-only outcome; a
 * `503` is never described as admitted, and a `2xx` from a surface the model
 * treats as read-only still fails.
 *
 * Every check runs twice, once per kind of Foundry principal:
 *
 * - **Unrestricted** (no namespace grants): the BFF signs it without an `ns`
 *   claim, so fleet-global probes and `/health` go out claim-less, as Foundry
 *   sends them. Routes that address a namespace (the namespace-scoped
 *   resources and the registry) carry the claim, because the gateways the
 *   contract runs against set `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM`; the role
 *   and admission answer is the same either way.
 * - **Namespace-scoped**: every request carries the claim, and the facts come
 *   from the scoped `/health` reduced by the BFF's own `projectHealthSummary`.
 *   Ferrum Edge v0.9.15 and earlier answer that token with the detailed tier;
 *   v0.9.16+ (ferrum-edge#6093) with the tenant tier, which carries the same
 *   `mode`, `admin_writes_enabled`, and `status`. A probe the BFF's namespace
 *   route ceiling refuses (`proxyPathIsAllowedForNamespace`) is never sent:
 *   the model must withhold it instead (a namespace-scope or role verdict for
 *   a write, a denied fleet view for a read). A probe the ceiling forwards is
 *   compared with the gateway exactly as above, so a route Edge v0.9.16+
 *   refuses to an `ns`-claim JWT, but the BFF forwards, fails the contract.
 *
 * Run directly against a gateway whose mode is fixed by
 * `FERRUM_CAPABILITY_EXPECT` (`writable` or `read-only`); the contract first
 * proves the gateway really is in that mode, so it cannot pass vacuously.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  CAPABILITY_SURFACES,
  capabilityRequirement,
  resolveCapability,
  resolveFleetView,
  resolveGatewayWriteState,
  resolveReadOnlyModeState,
} from "../src/lib/capabilities.ts";
import { projectHealthSummary } from "../server/health-summary.ts";
import { proxyPathIsAllowedForNamespace } from "../server/proxy-path.ts";
import {
  adminToken,
  confirmDestructiveTarget,
  readSeedConfig,
} from "./seed-demo-gateway.mjs";

export const ROLES = ["viewer", "operator", "admin"];
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

/** An id and namespace name that no probe expects to exist. */
export const PROBE_ID = "capability-parity-probe";

/**
 * Whether the BFF's namespace route ceiling forwards this request for a
 * principal holding namespace grants, judged by the BFF's own classifier on
 * the path it would proxy.
 */
export function bffForwardsScoped(method, path) {
  const url = `/api/proxy${path}`;
  return proxyPathIsAllowedForNamespace({
    method,
    url,
    raw: { url },
    routeOptions: { url: "/api/proxy/*" },
  });
}

/**
 * Whether a request addresses a namespace: a namespace-scoped route or the
 * namespace registry. Everything else the ceiling forwards (`/plugins`,
 * `/live`, `/health`, `/status`) and every fleet-global route does not.
 */
export function addressesNamespace(method, path) {
  return bffForwardsScoped(method, path) && !/^\/(plugins|live|health|status)(\?|$)/.test(path);
}

/**
 * One request per gateway-backed surface, each reaching the same role check
 * and write gate as the surface's real mutations.
 */
export const WRITE_PROBES = {
  proxies: { method: "DELETE", path: `/proxies/${PROBE_ID}`, admittedStatus: 404 },
  upstreams: { method: "DELETE", path: `/upstreams/${PROBE_ID}`, admittedStatus: 404 },
  pluginConfigs: { method: "DELETE", path: `/plugins/config/${PROBE_ID}`, admittedStatus: 404 },
  consumers: { method: "DELETE", path: `/consumers/${PROBE_ID}`, admittedStatus: 404 },
  consumerCredentials: { method: "DELETE", path: `/consumers/${PROBE_ID}/credentials/keyauth/0`, admittedStatus: 404 },
  apiSpecs: { method: "DELETE", path: `/api-specs/${PROBE_ID}`, admittedStatus: 404 },
  namespaceRegistry: { method: "DELETE", path: `/namespaces/${PROBE_ID}`, admittedStatus: 404 },
  gatewayTrust: { method: "DELETE", path: `/gateway-trust-bundles/${PROBE_ID}`, admittedStatus: 404 },
  // No `?confirm=true` and not JSON: Edge refuses it after admission and
  // before it would read the payload, so the restore can never run. In file/DP
  // mode `require_db` answers the documented `503 {"error":"No database"}`
  // before the read-only gate, which a read-only expectation accepts as an
  // unavailable no-writable-store outcome.
  configBackup: {
    method: "POST",
    path: "/restore",
    rawBody: "{",
    acceptsNoDatabaseRestore: true,
  },
  configExport: { method: "GET", path: "/backup" },
  tlsMaterial: { method: "DELETE", path: `/admin/tls/certificates/${PROBE_ID}`, admittedStatus: 404 },
  // `handle_rotate` checks the role and audit admission, then refuses a
  // surface it does not know with `400` before requesting any reload.
  tlsRotation: { method: "POST", path: `/admin/tls/rotate/${PROBE_ID}`, admittedStatus: 400 },
  operationalActions: { method: "POST", path: "/admin/tls/validate", body: {} },
  // `handle_mesh_egress_scope_test` checks the operator role, then answers a
  // gateway without a mesh egress scope `404 {"error":"No active mesh egress
  // scope"}` before it reads the body. It is a stateless dry-run either way.
  fleetOperations: {
    method: "POST",
    path: "/mesh/egress-scope/test",
    body: { host: `${PROBE_ID}.invalid` },
    admittedStatus: 404,
  },
};

/** Surfaces the gateway never sees; the BFF's own tests cover them. */
export const BFF_ONLY_SURFACES = new Set(["bffSettings"]);

/**
 * Reads that decide whether a page shows data. `collection` reads are the
 * launch workflows: every role must receive a real collection from them.
 */
export const READ_PROBES = [
  { label: "proxies", path: "/proxies?offset=0&limit=1", minimumRole: "viewer", collection: true },
  {
    label: "MCP tool catalog",
    path: `/proxies/${PROBE_ID}/mcp/tools?offset=0&limit=1`,
    minimumRole: "viewer",
    // The catalog handler's own answer for a missing proxy
    // (`Proxy::NOT_FOUND_MESSAGE`, ferrum-edge v0.9.9 `mcp_tool_catalog.rs`).
    // A router's generic `{"error":"Not Found"}` would mean the route does not
    // exist, so the status alone proves nothing.
    expectedStatus: 404,
    expectedError: "Proxy not found",
  },
  { label: "upstreams", path: "/upstreams?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "consumers", path: "/consumers?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "plugin configs", path: "/plugins/config?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "namespaces", path: "/namespaces?offset=0&limit=1", minimumRole: "viewer", collection: true },
  {
    label: "TLS inventory",
    path: "/admin/tls/inventory?offset=0&limit=1",
    minimumRole: "operator",
    // Fleet-global: a namespace-scoped session gets the TLS view's reason.
    fleetView: "tls",
  },
  { label: "gateway trust bundles", path: "/gateway-trust-bundles?offset=0&limit=1", minimumRole: "operator" },
  { label: "audit log", path: "/audit?offset=0&limit=1", minimumRole: "admin" },
];

const ROLE_DENIAL = /required role is '(viewer|operator|admin)'/;
const READ_ONLY_DENIAL = /read-only mode/i;

/**
 * Edge's documented no-database refusal for `POST /restore`
 * (`handle_restore` → `require_db`, `src/admin/mod.rs`, v0.9.9+). A `file` or
 * `dp` gateway has no configuration database, so it answers this exact typed
 * `503` before the read-only gate. The restore never ran, so it is a
 * no-writable-store precondition, not an admission.
 */
export function isNoDatabaseRestore(response) {
  return response.status === 503 && response.body?.error === "No database";
}

/** Classify a response as the gateway's own refusal, or `null` if admitted. */
export function classifyDenial(response) {
  if (response.status !== 403) return null;
  const message = typeof response.body?.error === "string" ? response.body.error : "";
  const role = ROLE_DENIAL.exec(message)?.[1];
  if (role) return { kind: "role", requiredRole: role };
  if (READ_ONLY_DENIAL.test(message)) return { kind: "gateway-read-only" };
  if (NS_CLAIM_DENIAL.test(message)) return { kind: "namespace-claim", message };
  return { kind: "other", message };
}

function isCollection(body) {
  return Array.isArray(body) || Array.isArray(body?.data);
}

/**
 * Edge v0.9.16+'s refusal of a fleet-global route to an admin JWT carrying an
 * `ns` claim (`authorize_namespace_bounded_global_route`, ferrum-edge#6093).
 */
const NS_CLAIM_DENIAL = /unavailable to admin JWTs with an `ns` claim/;

/** The capability facts the UI derives from an authenticated `/health`. */
export function observedFacts(health) {
  return {
    mode: typeof health?.mode === "string" ? health.mode : null,
    adminWritesEnabled:
      typeof health?.admin_writes_enabled === "boolean" ? health.admin_writes_enabled : null,
    status: typeof health?.status === "string" ? health.status : null,
  };
}

function describeExpected(verdict, surface) {
  if (verdict.allowed) return "admitted";
  if (verdict.blockedBy === "role") {
    return `role denial requiring ${capabilityRequirement(surface).minimumRole}`;
  }
  return "read-only denial";
}

function describeActual(response, denial) {
  if (response.status === 401) return "401: authentication failed, nothing was tested";
  // A 503 is never an admission: the write did not run.
  if (isNoDatabaseRestore(response)) return '503 "No database" (restore unavailable)';
  if (response.status === 503) {
    return `503 unavailable (${JSON.stringify(response.body?.error ?? response.body)})`;
  }
  if (!denial) return `admitted (${response.status})`;
  if (denial.kind === "role") return `role denial requiring ${denial.requiredRole}`;
  if (denial.kind === "gateway-read-only") return "read-only denial";
  if (denial.kind === "namespace-claim") return `ns-claim denial ${JSON.stringify(denial.message)}`;
  return `403 ${JSON.stringify(denial.message)}`;
}

/** The scoped principal's grants, as `gatewaySender` signs them. */
export function scopedGrants(namespace) {
  return [namespace, PROBE_ID];
}

/**
 * Compare every write and read probe with the model for one principal. A
 * scoped principal's probe that the BFF's ceiling refuses is not sent; the
 * model must withhold it instead.
 */
async function comparePrincipal(send, { expectation, observed, scoped, mismatches }) {
  const who = (role) => (scoped ? `scoped ${role}` : role);
  const surfaces = CAPABILITY_SURFACES.filter((surface) => !BFF_ONLY_SURFACES.has(surface));
  const writes = {};
  for (const role of ROLES) {
    writes[role] = {};
    for (const surface of surfaces) {
      const probe = WRITE_PROBES[surface];
      const facts = { role, namespaceScoped: scoped, ...observed };
      const verdict = resolveCapability(surface, facts);
      const label = `${who(role)} ${surface} (${probe.method} ${probe.path})`;

      if (scoped && !bffForwardsScoped(probe.method, probe.path)) {
        // The BFF refuses it before signing; the UI must not offer it either.
        writes[role][surface] = "bff-refused";
        if (verdict.allowed) {
          mismatches.push(`${label}: model offers it, but the BFF namespace route ceiling refuses it`);
        }
        continue;
      }
      if (scoped && verdict.blockedBy === "namespace-scope") {
        mismatches.push(`${label}: model withholds it as fleet-wide, but the BFF forwards it`);
        continue;
      }

      const response = await send(role, probe, { scoped });
      const denial = classifyDenial(response);
      writes[role][surface] = response.status;

      let agrees;
      if (response.status === 401) {
        agrees = false; // authentication failed: the probe tested nothing
      } else if (verdict.allowed) {
        const admittedStatus = probe.admittedStatus;
        // A 503 is a failed or unavailable write, never an admission.
        agrees = denial === null
          && response.status !== 503
          && (admittedStatus === undefined || response.status === admittedStatus);
      } else if (verdict.blockedBy === "role") {
        agrees = denial?.kind === "role"
          && denial.requiredRole === capabilityRequirement(surface).minimumRole;
      } else {
        // File/DP restore answers the documented `503 {"error":"No database"}`
        // before the read-only gate; under a read-only expectation that is an
        // expected no-writable-store outcome, not an admission.
        const readOnlyDenial = denial?.kind === "gateway-read-only";
        const noDatabaseRestore = expectation === "read-only"
          && probe.acceptsNoDatabaseRestore === true
          && isNoDatabaseRestore(response);
        agrees = readOnlyDenial || noDatabaseRestore;
      }
      if (!agrees) {
        mismatches.push(
          `${label}: model expects ${describeExpected(verdict, surface)}, `
          + `gateway answered ${describeActual(response, denial)}`,
        );
      }
    }
  }

  const reads = {};
  for (const role of ROLES) {
    reads[role] = {};
    for (const probe of READ_PROBES) {
      if (scoped && !bffForwardsScoped("GET", probe.path)) {
        reads[role][probe.label] = "bff-refused";
        const facts = { role, namespaceScoped: true, ...observed };
        if (!probe.fleetView || resolveFleetView(probe.fleetView, facts).allowed) {
          mismatches.push(
            `${who(role)} read of ${probe.label}: the BFF namespace route ceiling refuses it, `
            + "but no fleet view withholds it",
          );
        }
        continue;
      }
      const response = await send(role, { method: "GET", path: probe.path }, { scoped });
      const denial = classifyDenial(response);
      reads[role][probe.label] = response.status;
      if (ROLE_RANK[role] >= ROLE_RANK[probe.minimumRole]) {
        if (response.status === 401 || denial) {
          mismatches.push(`${who(role)} read of ${probe.label} was refused (${response.status})`);
        } else if (probe.expectedStatus !== undefined && response.status !== probe.expectedStatus) {
          mismatches.push(
            `${who(role)} read of ${probe.label} returned ${response.status}, expected ${probe.expectedStatus}`,
          );
        } else if (
          probe.expectedError !== undefined && response.body?.error !== probe.expectedError
        ) {
          mismatches.push(
            `${who(role)} read of ${probe.label} answered ${JSON.stringify(response.body?.error)}, `
            + `expected the handler's ${JSON.stringify(probe.expectedError)}`,
          );
        } else if (probe.collection && !(response.status === 200 && isCollection(response.body))) {
          mismatches.push(
            `${who(role)} read of ${probe.label} returned ${response.status} without a collection`,
          );
        }
      } else if (denial?.kind !== "role" || denial.requiredRole !== probe.minimumRole) {
        // A 404/501/503 here would be rendered as "not enabled on this gateway".
        mismatches.push(
          `${who(role)} read of ${probe.label}: expected an explicit 403 requiring ${probe.minimumRole}, `
          + `gateway answered ${describeActual(response, denial)}`,
        );
      }
    }
  }
  return { writes, reads };
}

/**
 * The facts a namespace-scoped session's UI reads: the scoped `/health`,
 * reduced by the BFF's `projectHealthSummary` for the scoped grants. Every
 * fact it carries must match the unrestricted reading of the same gateway.
 */
async function scopedFacts(send, observed, grants, mismatches) {
  const health = await send("admin", { method: "GET", path: "/health" }, { scoped: true });
  assert.equal(health.status, 200, `scoped GET /health returned ${health.status}`);
  const summary = projectHealthSummary(health.body, grants);
  assert.ok(summary, "scoped GET /health has no summary");
  const facts = observedFacts(summary);
  for (const [fact, value] of Object.entries(facts)) {
    if (value !== null && value !== observed[fact]) {
      mismatches.push(
        `scoped /health reports ${fact} ${JSON.stringify(value)}, `
        + `unrestricted /health ${JSON.stringify(observed[fact])}`,
      );
    }
  }
  return facts;
}

/**
 * @param send `(role, { method, path, body?, rawBody? }, { scoped }) =>
 *   Promise<{ status, body }>`, signing as the given role for the namespace
 *   under test, as an unrestricted or a namespace-scoped principal.
 * @param options.expectation `"writable"` or `"read-only"`: the mode the
 *   gateway was started in, proved before anything else is compared.
 * @param options.grants the scoped principal's grants, as `gatewaySender`
 *   signs them, for the BFF's health summary.
 */
export async function verifyCapabilityParity(send, { expectation, grants = [] } = {}) {
  assert.ok(
    expectation === "writable" || expectation === "read-only",
    'expectation must be "writable" or "read-only"',
  );

  const health = await send("admin", { method: "GET", path: "/health" }, { scoped: false });
  assert.equal(health.status, 200, `GET /health returned ${health.status}`);
  const observed = observedFacts(health.body);
  const unknownRole = { role: null, ...observed };
  if (expectation === "writable") {
    assert.equal(
      resolveGatewayWriteState(unknownRole).state,
      "enabled",
      `expected a writable gateway, /health reported ${JSON.stringify(observed)}`,
    );
  } else {
    assert.equal(
      resolveReadOnlyModeState(unknownRole).state,
      "read-only",
      `expected a read-only gateway, /health reported ${JSON.stringify(observed)}`,
    );
  }

  const surfaces = CAPABILITY_SURFACES.filter((surface) => !BFF_ONLY_SURFACES.has(surface));
  assert.deepEqual(
    Object.keys(WRITE_PROBES).sort(),
    [...surfaces].sort(),
    "every gateway-backed capability surface needs exactly one parity probe",
  );

  const mismatches = [];
  const { writes, reads } = await comparePrincipal(send, {
    expectation, observed, scoped: false, mismatches,
  });
  const scopedObserved = await scopedFacts(send, observed, grants, mismatches);
  const scoped = await comparePrincipal(send, {
    expectation, observed: scopedObserved, scoped: true, mismatches,
  });

  assert.deepEqual(mismatches, [], `capability model and gateway disagree:\n${mismatches.join("\n")}`);
  return {
    expectation,
    observed,
    writes,
    reads,
    scoped: { observed: scopedObserved, ...scoped },
  };
}

/**
 * Sign each request as `role` for `config.namespace`, as the BFF would. A
 * namespace-scoped principal's token always carries the `ns` claim. An
 * unrestricted principal's carries none, except on a route that addresses a
 * namespace, where `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM` would refuse it.
 */
export function gatewaySender(config, { fetchImpl = fetch } = {}) {
  return async (role, { method, path, body, rawBody }, { scoped = false } = {}) => {
    const token = await adminToken(config, {
      role,
      subject: `ferrum-foundry-capability-parity-${role}`,
      // The registry probe names PROBE_ID; with FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM
      // an ungranted name would be a namespace denial, not the gate under test.
      namespaces: scoped || addressesNamespace(method, path)
        ? scopedGrants(config.namespace)
        : undefined,
    });
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const response = await fetchImpl(`${config.adminUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-ferrum-namespace": config.namespace,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      body: payload,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
}

/** Require explicit acknowledgement before probes can reach a writable target. */
export function confirmWritableParityTarget(config, expectation) {
  if (expectation === "writable") confirmDestructiveTarget(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readSeedConfig();
  const expectation = process.env.FERRUM_CAPABILITY_EXPECT?.trim();
  confirmWritableParityTarget(config, expectation);
  verifyCapabilityParity(gatewaySender(config), {
    expectation,
    grants: scopedGrants(config.namespace),
  })
    .then((result) => console.log(JSON.stringify({ verified: true, capabilityParity: result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Capability parity check failed");
      process.exitCode = 1;
    });
}
