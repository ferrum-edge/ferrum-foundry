import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHTTPError } from "ky";
import * as mesh from "./mesh";
import { getApiErrorDetail, setApiErrorHandler, setCsrfToken } from "./client";
import { stubFetch } from "@/test/__tests__/harness";
import { meshResponses } from "@/test/__tests__/meshFixtures";

const scope = { namespace: "tenant-a" };
let requests: Request[];
const popup = vi.fn();

beforeEach(() => {
  requests = [];
  popup.mockClear();
  setApiErrorHandler(popup);
  setCsrfToken("fixture-csrf");
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    if (path in meshResponses) return Response.json(meshResponses[path]);
    if (path === "mesh/config-revision/reset") return Response.json({ status: "reset", cleared_revision: null });
    if (path === "mesh/egress-scope/test") {
      const body = await request.clone().json();
      return Response.json({ allowed: true, decision: "admit", host: body.host, port: body.port ?? null, dry_run: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  setApiErrorHandler(undefined);
  setCsrfToken(null);
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("mesh API contracts", () => {
  it.each([
    ["mesh/service-graph", mesh.getServiceGraph],
    ["mesh/egress-scope", mesh.getEgressScope],
    ["mesh/federation", mesh.getFederation],
    ["mesh/remote-clusters", mesh.getRemoteClusters],
    ["mesh/config-drift", mesh.getConfigDrift],
    ["mesh/slice-drift", mesh.getSliceDrift],
    ["mesh/policy-denies/recent", mesh.getPolicyDenies],
    ["node-waypoint/identities", mesh.getNodeWaypointIdentities],
    ["service-waypoint/services", mesh.getServiceWaypointServices],
  ] as const)("reads %s with the operation's namespace", async (path, read) => {
    localStorage.setItem("ferrum:namespace", "unrelated-tenant");
    expect(await read(scope)).toEqual(meshResponses[path]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(`/api/proxy/${path}`);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    expect(requests[0].headers.has("X-CSRF-Token")).toBe(false);
  });

  it("serializes default and custom deny windows", async () => {
    await mesh.getPolicyDenies(scope);
    await mesh.getPolicyDenies(scope, "15m", 100);
    expect(requests.map((request) => Object.fromEntries(new URL(request.url).searchParams))).toEqual([
      { window: "5m", limit: "50" }, { window: "15m", limit: "100" },
    ]);
  });

  it.each([undefined, 443])("tests a destination with optional port %s", async (port) => {
    expect(await mesh.testEgressScope(scope, "orders.api.svc", port)).toEqual({
      allowed: true, decision: "admit", host: "orders.api.svc", port: port ?? null, dry_run: true,
    });
    expect(await requests[0].json()).toEqual(port === undefined ? { host: "orders.api.svc" } : { host: "orders.api.svc", port });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("X-CSRF-Token")).toBe("fixture-csrf");
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
  });

  it("resets the configuration revision without inventing a request body", async () => {
    expect(await mesh.resetConfigRevision(scope)).toEqual({ status: "reset", cleared_revision: null });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    expect(await requests[0].text()).toBe("");
  });

  it.each([404, 503])("keeps expected feature misses (%s) out of the global popup", async (status) => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(
      { error: "Mesh mode is unavailable" }, { status, headers: { "retry-after": "0" } },
    ));
    const error = await mesh.getServiceGraph(scope).catch((failure: unknown) => failure);
    expect(isHTTPError(error)).toBe(true);
    expect(await getApiErrorDetail(error)).toBe("Mesh mode is unavailable");
    expect(popup).not.toHaveBeenCalled();
  });

  it("retains rejected destination details without replaying a POST", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "host: invalid destination" }, { status: 400 }));
    const error = await mesh.testEgressScope(scope, "invalid host").catch((failure: unknown) => failure);
    expect(isHTTPError(error)).toBe(true);
    if (!isHTTPError(error)) throw new Error("Expected HTTP rejection");
    expect(error.response.bodyUsed).toBe(true);
    expect(await getApiErrorDetail(error)).toBe("host: invalid destination");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('runtime overlay contract', () => {
  it('keeps the accepted slice envelope and tagged wire values', async () => {
    const snapshot = { namespace: 'tenant-a', version: 'v1', runtime_overlay: { fields: {
      number: { kind: 'number', value: 1.5 }, string: { kind: 'string', value: 'warn' },
      boolean: { kind: 'bool', value: false }, fraction: { kind: 'fractional_percent', value: { numerator: 25, denominator: 'hundred' } },
    } } };
    stubFetch(request => { requests.push(request); return Response.json(snapshot); });
    expect(await mesh.getRuntimeOverlay(scope)).toEqual(snapshot);
    expect(new URL(requests[0].url).pathname).toBe('/api/proxy/mesh/runtime-overlay');
    expect(requests[0].headers.get('X-Ferrum-Namespace')).toBe('tenant-a');
  });

  it.each([{}, { fields: {} }])('accepts an empty accepted overlay %o', async runtime_overlay => {
    stubFetch(() => Response.json({ namespace: 'tenant-a', version: 'v1', runtime_overlay }));
    expect((await mesh.getRuntimeOverlay(scope)).runtime_overlay).toEqual(runtime_overlay);
  });

  it.each([
    {}, { nodes: [] }, { namespace: 'a', version: 'v', runtime_overlay: null },
    { namespace: 'a', version: 'v', runtime_overlay: { fields: { bad: true } } },
    { namespace: 'a', version: 'v', runtime_overlay: { fields: { bad: { kind: 'bool', value: 'false' } } } },
    { namespace: 'a', version: 'v', runtime_overlay: { fields: { bad: { kind: 'fractional_percent', value: { numerator: 1, denominator: '100' } } } } },
    { namespace: 'a', version: 'v', runtime_overlay: { fields: { bad: { kind: 'fractional_percent', value: { numerator: 1, denominator: ['hundred'] } } } } },
  ])('rejects invalid data instead of showing an empty overlay (%#)', async body => {
    stubFetch(() => Response.json(body));
    await expect(mesh.getRuntimeOverlay(scope)).rejects.toThrow('invalid runtime overlay snapshot');
  });

  it.each([404, 503])('silences documented probe status %s without swallowing it', async status => {
    const transport = stubFetch(() => Response.json({ error: 'No active mesh runtime overlay' }, { status }));
    await expect(mesh.getRuntimeOverlay(scope)).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
    expect(popup).not.toHaveBeenCalled();
  });

  it('retains authorization and network failures', async () => {
    stubFetch(() => Response.json({ error: 'Forbidden' }, { status: 403 }));
    await expect(mesh.getRuntimeOverlay(scope)).rejects.toThrow();
    expect(popup).toHaveBeenCalled();
    stubFetch(() => { throw new TypeError('offline'); });
    await expect(mesh.getRuntimeOverlay(scope)).rejects.toThrow();
  });
});
