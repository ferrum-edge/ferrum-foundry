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
 * Every write probe is non-mutating by construction: a `DELETE` of an id that
 * does not exist, `POST /admin/tls/validate` (non-persistent), `GET /backup`,
 * or a `POST /restore` without `?confirm=true` and with a body that is not
 * JSON. Each still passes through exactly the role check and the admission
 * gate the surface mirrors, because Edge applies both before it looks the
 * resource up (ferrum-edge b96cfaa, the pinned build, and v0.9.5 alike:
 * `crud::handle_delete`, `handle_restore`,
 * `tls_management::handle_delete_managed`).
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
  resolveGatewayWriteState,
  resolveReadOnlyModeState,
} from "../src/lib/capabilities.ts";
import { adminToken, readSeedConfig } from "./seed-demo-gateway.mjs";

export const ROLES = ["viewer", "operator", "admin"];
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

/** An id and namespace name that no probe expects to exist. */
export const PROBE_ID = "capability-parity-probe";

/**
 * One request per gateway-backed surface, each reaching the same role check
 * and write gate as the surface's real mutations.
 */
export const WRITE_PROBES = {
  proxies: { method: "DELETE", path: `/proxies/${PROBE_ID}` },
  upstreams: { method: "DELETE", path: `/upstreams/${PROBE_ID}` },
  pluginConfigs: { method: "DELETE", path: `/plugins/config/${PROBE_ID}` },
  consumers: { method: "DELETE", path: `/consumers/${PROBE_ID}` },
  consumerCredentials: { method: "DELETE", path: `/consumers/${PROBE_ID}/credentials/keyauth/0` },
  apiSpecs: { method: "DELETE", path: `/api-specs/${PROBE_ID}` },
  namespaceRegistry: { method: "DELETE", path: `/namespaces/${PROBE_ID}` },
  gatewayTrust: { method: "DELETE", path: `/gateway-trust-bundles/${PROBE_ID}` },
  // No `?confirm=true` and not JSON: Edge refuses it after admission and
  // before it would read the payload, so the restore can never run.
  configBackup: { method: "POST", path: "/restore", rawBody: "{" },
  configExport: { method: "GET", path: "/backup" },
  tlsMaterial: { method: "DELETE", path: `/admin/tls/certificates/${PROBE_ID}` },
  operationalActions: { method: "POST", path: "/admin/tls/validate", body: {} },
};

/** Surfaces the gateway never sees; the BFF's own tests cover them. */
export const BFF_ONLY_SURFACES = new Set(["bffSettings"]);

/**
 * Reads that decide whether a page shows data. `collection` reads are the
 * launch workflows: every role must receive a real collection from them.
 */
export const READ_PROBES = [
  { label: "proxies", path: "/proxies?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "upstreams", path: "/upstreams?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "consumers", path: "/consumers?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "plugin configs", path: "/plugins/config?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "namespaces", path: "/namespaces?offset=0&limit=1", minimumRole: "viewer", collection: true },
  { label: "TLS inventory", path: "/admin/tls/inventory?offset=0&limit=1", minimumRole: "operator" },
  { label: "gateway trust bundles", path: "/gateway-trust-bundles?offset=0&limit=1", minimumRole: "operator" },
  { label: "audit log", path: "/audit?offset=0&limit=1", minimumRole: "admin" },
];

const ROLE_DENIAL = /required role is '(viewer|operator|admin)'/;
const READ_ONLY_DENIAL = /read-only mode/i;

/** Classify a response as the gateway's own refusal, or `null` if admitted. */
export function classifyDenial(response) {
  if (response.status !== 403) return null;
  const message = typeof response.body?.error === "string" ? response.body.error : "";
  const role = ROLE_DENIAL.exec(message)?.[1];
  if (role) return { kind: "role", requiredRole: role };
  if (READ_ONLY_DENIAL.test(message)) return { kind: "gateway-read-only" };
  return { kind: "other", message };
}

function isCollection(body) {
  return Array.isArray(body) || Array.isArray(body?.data);
}

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
  if (!denial) return `admitted (${response.status})`;
  if (denial.kind === "role") return `role denial requiring ${denial.requiredRole}`;
  if (denial.kind === "gateway-read-only") return "read-only denial";
  return `403 ${JSON.stringify(denial.message)}`;
}

/**
 * @param send `(role, { method, path, body?, rawBody? }) => Promise<{ status, body }>`,
 *   signing as the given role for the namespace under test.
 * @param options.expectation `"writable"` or `"read-only"`: the mode the
 *   gateway was started in, proved before anything else is compared.
 */
export async function verifyCapabilityParity(send, { expectation } = {}) {
  assert.ok(
    expectation === "writable" || expectation === "read-only",
    'expectation must be "writable" or "read-only"',
  );

  const health = await send("admin", { method: "GET", path: "/health" });
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
  const writes = {};
  for (const role of ROLES) {
    writes[role] = {};
    for (const surface of surfaces) {
      const verdict = resolveCapability(surface, { role, ...observed });
      const response = await send(role, WRITE_PROBES[surface]);
      const denial = classifyDenial(response);
      writes[role][surface] = response.status;

      let agrees;
      if (response.status === 401) {
        agrees = false; // authentication failed: the probe tested nothing
      } else if (verdict.allowed) {
        agrees = denial === null;
      } else if (verdict.blockedBy === "role") {
        agrees = denial?.kind === "role"
          && denial.requiredRole === capabilityRequirement(surface).minimumRole;
      } else {
        agrees = denial?.kind === "gateway-read-only";
      }
      if (!agrees) {
        mismatches.push(
          `${role} ${surface} (${WRITE_PROBES[surface].method} ${WRITE_PROBES[surface].path}): `
          + `model expects ${describeExpected(verdict, surface)}, `
          + `gateway answered ${describeActual(response, denial)}`,
        );
      }
    }
  }

  const reads = {};
  for (const role of ROLES) {
    reads[role] = {};
    for (const probe of READ_PROBES) {
      const response = await send(role, { method: "GET", path: probe.path });
      const denial = classifyDenial(response);
      reads[role][probe.label] = response.status;
      if (ROLE_RANK[role] >= ROLE_RANK[probe.minimumRole]) {
        if (response.status === 401 || denial) {
          mismatches.push(`${role} read of ${probe.label} was refused (${response.status})`);
        } else if (probe.collection && !(response.status === 200 && isCollection(response.body))) {
          mismatches.push(
            `${role} read of ${probe.label} returned ${response.status} without a collection`,
          );
        }
      } else if (denial?.kind !== "role" || denial.requiredRole !== probe.minimumRole) {
        // A 404/501/503 here would be rendered as "not enabled on this gateway".
        mismatches.push(
          `${role} read of ${probe.label}: expected an explicit 403 requiring ${probe.minimumRole}, `
          + `gateway answered ${describeActual(response, denial)}`,
        );
      }
    }
  }

  assert.deepEqual(mismatches, [], `capability model and gateway disagree:\n${mismatches.join("\n")}`);
  return { expectation, observed, writes, reads };
}

/** Sign each request as `role` for `config.namespace`, as the BFF would. */
export function gatewaySender(config, { fetchImpl = fetch } = {}) {
  return async (role, { method, path, body, rawBody }) => {
    const token = await adminToken(config, {
      role,
      subject: `ferrum-foundry-capability-parity-${role}`,
      // The registry probe names PROBE_ID; with FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM
      // an ungranted name would be a namespace denial, not the gate under test.
      namespaces: [config.namespace, PROBE_ID],
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readSeedConfig();
  verifyCapabilityParity(gatewaySender(config), {
    expectation: process.env.FERRUM_CAPABILITY_EXPECT?.trim(),
  })
    .then((result) => console.log(JSON.stringify({ verified: true, capabilityParity: result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Capability parity check failed");
      process.exitCode = 1;
    });
}
