import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiErrorHandler } from "@/api/client";
import { inputByLabel } from "@/test/fields";
import { BasedRequest, click, createHarness, fill, page, panel, selectTab, settle } from "@/test/__tests__/harness";
import { config, denies, graph, meshResponses } from "@/test/__tests__/meshFixtures";
import MeshPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "tenant-a", scope: { namespace: "tenant-a" } }),
}));

let ui: ReturnType<typeof createHarness>;
let responses: Record<string, unknown>;
let failure: number | undefined;
let requests: Request[];
let destinationStatus: number;
let decision: "admit" | "deny";
const popup = vi.fn();

beforeEach(() => {
  ui = createHarness();
  responses = { ...meshResponses };
  requests = [];
  failure = undefined;
  destinationStatus = 200;
  decision = "admit";
  popup.mockClear();
  setApiErrorHandler(popup);
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    if (failure) return Response.json({ error: "Feature unavailable" }, { status: failure, headers: { "retry-after": "0" } });
    if (path === "mesh/egress-scope/test") {
      const body = await request.clone().json();
      return destinationStatus === 200
        ? Response.json({ allowed: decision === "admit", decision, host: body.host, port: body.port ?? null, dry_run: true })
        : Response.json({ error: "host: destination rejected" }, { status: destinationStatus });
    }
    if (path === "health") return Response.json({ status: "ok", ready: true, mode: "database" });
    if (path === "gateway-trust-bundles") return Response.json(page([]));
    if (path === "gateway-trust/status") return Response.json({ configured: false });
    if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
    return Response.json(responses[path]);
  }));
});
afterEach(async () => {
  await ui.dispose();
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
});

async function open(tab: string, expected: string) {
  await ui.render(<MeshPage />);
  if (tab !== "Overview") await selectTab(tab);
  await settle(() => expect(panel().textContent).toContain(expected));
}

describe("mesh tab observations", () => {
  it("renders quarantine, missing xDS types, and each data plane convergence state", async () => {
    await open("Overview", "dp-disconnected");
    for (const label of ["420s", "ACTIVE", "service entries", "slice-v2", "Quarantined Revision",
      "cp-primary seq 2", "invalid policy", "version skew", "Missing: LDS", "1/5 converged",
      "dp-converged", "dp-drifted", "dp-rejecting", "dp-pending", "rejected slice-v3"]) {
      expect(panel().textContent).toContain(label);
    }
    responses["mesh/config-drift"] = {
      ...config, slice: { source_protocol: "native", source_cp_url: "", resources: {} },
      convergence: undefined, revision: { adopted_total: 1, rejected_total: 0, quarantine_active: false },
    };
    await act(async () => { await ui.client.refetchQueries({ queryKey: ["mesh", "configDrift"] }); });
    await settle(() => expect(panel().textContent).toContain("native"));
    expect(panel().textContent).not.toContain("Quarantined Revision");
    expect(panel().textContent).not.toContain("xDS Convergence");
  });

  it("renders service edges, latency, security, and workload fallbacks", async () => {
    responses["mesh/service-graph"] = {
      ...graph, edge_count: 3, edges: [graph.edges[0],
        { ...graph.edges[0], source_workload: "", destination_service: "", errors_total: 0 },
        { ...graph.edges[0], source_workload: "", source_app: "", destination_service: "",
          destination_workload: "", connection_security_policy: "" }],
    };
    await open("Service Graph", "3 edge(s)");
    for (const label of ["frontend-7d9", "orders-5f2", "48211", "10.0", "mutual_tls", "unknown"]) {
      expect(panel().textContent).toContain(label);
    }
  });

  it("renders grouped policy denies and requests the displayed observation window", async () => {
    await open("Policy Denies", "deny-external");
    expect(panel().textContent).toContain("Denies (15m)");
    expect(panel().textContent).toContain("frontend → outside");
    expect(panel().textContent).toContain("3×");
    const request = requests.find((entry) => entry.url.includes("policy-denies"))!;
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ window: "15m", limit: "100" });
  });

  it("distinguishes configured clusters, discovered-only clusters, and trust directions", async () => {
    await open("Clusters", "Federated Trust Bundles");
    for (const label of ["discovery on", "discovered only", "east", "outbound trust active",
      "inbound trust inactive", "control plane", "private-west", "2 x509", "1 jwt", "20s old"]) {
      expect(panel().textContent).toContain(label);
    }
    expect(panel().textContent?.match(/discovered only/g)).toHaveLength(1);
  });

  it("renders waypoint identities, cookie totals, scoped policies and service ports", async () => {
    await open("Waypoints", "orders-waypoint");
    for (const label of ["pod-orders", "spiffe://prod/ns/api/sa/orders", "5 cookies", "policy scope",
      "api/orders", "ports 80, 443", "3 workloads"]) expect(panel().textContent).toContain(label);
  });

  it("shows a successful empty observation rather than a feature failure", async () => {
    responses["mesh/service-graph"] = { ...graph, edges: [], edge_count: 0 };
    responses["mesh/policy-denies/recent"] = { ...denies, grouped: [], total_denies: 0 };
    responses["mesh/remote-clusters"] = { discovery_enabled: false, configured: [], discovered: [] };
    responses["mesh/federation"] = { bundles: [] };
    await open("Service Graph", "No traffic observed");
    await selectTab("Policy Denies");
    await settle(() => expect(panel().textContent).toContain("No recent denies"));
    await selectTab("Clusters");
    await settle(() => expect(panel().textContent).toContain("No remote clusters"));
    expect(panel().textContent).toContain("discovery off");
    expect(panel().textContent).not.toContain("unavailable");
    await selectTab("Trust");
    await settle(() => expect(panel().textContent).toContain("Mesh trust is not active in database mode"));
  });

  it.each([404, 503])("renders each unsupported tab after HTTP %s without a global popup", async (status) => {
    failure = status;
    await open("Overview", "Mesh configuration state unavailable");
    for (const [tab, label] of [
      ["Service Graph", "Service graph unavailable"], ["Policy Denies", "Policy denies unavailable"],
      ["Clusters", "Remote clusters"], ["Egress", "Egress scope unavailable"],
      ["Waypoints", "Node waypoint identities"],
    ]) {
      await selectTab(tab);
      await settle(() => {
        expect(panel().textContent).toContain(label);
        expect(panel().textContent?.toLowerCase()).toContain("unavailable");
      });
    }
    expect(popup).not.toHaveBeenCalled();
    expect(requests.every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
  });

  it("tests admit and deny decisions and replaces a stale result with an actionable error", async () => {
    await open("Egress", "Known Destinations");
    expect(panel().textContent).toContain("orders.api.svc");
    await fill(inputByLabel(panel(), "Host"), "external.example.test");
    await fill(inputByLabel(panel(), "Port"), "443");
    await click("Test", panel());
    await settle(() => expect(panel().textContent).toContain("ADMIT — external.example.test:443 (dry-run mode)"));
    decision = "deny";
    await fill(inputByLabel(panel(), "Port"), "");
    await click("Test", panel());
    await settle(() => expect(panel().textContent).toContain("DENY — external.example.test (dry-run mode)"));
    destinationStatus = 400;
    await click("Test", panel());
    await settle(() => expect(document.body.textContent).toContain("host: destination rejected"));
    expect(panel().textContent).not.toContain("DENY —");
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(3);
    expect(await writes[0].json()).toEqual({ host: "external.example.test", port: 443 });
    expect(await writes[1].json()).toEqual({ host: "external.example.test" });
  });
});
