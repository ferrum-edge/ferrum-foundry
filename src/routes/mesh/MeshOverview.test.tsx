import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshConfigDriftResponse, MeshSliceDriftResponse } from "@/api/mesh";
import MeshPage from "./index";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "default" } }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
const config: MeshConfigDriftResponse = {
  slice: { source_protocol: "xds", source_cp_url: "https://cp.example.test", resources: {}, age_seconds: 3 },
  convergence: { per_type_versions: {}, missing_required_types: [], converged: true, version_skew: false },
  revision: { rejected_total: 0, adopted_total: 1, quarantine_active: false },
};
const slices: MeshSliceDriftResponse = {
  mode: "cp", generated_at: "2026-09-06T00:00:00Z",
  summary: { tracked: 0, connected: 0, converged: 0, drifted: 0, rejecting: 0, pending: 0, disconnected: 0 },
  data_planes: [],
};
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let failConfig: boolean;
let failSlices: boolean;

beforeEach(() => {
  failConfig = false;
  failSlices = false;
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const isConfig = new URL(request.url).pathname.endsWith("/config-drift");
    if (isConfig ? failConfig : failSlices) return new Response("Unavailable", { status: 404 });
    return Response.json(isConfig ? config : slices);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
});
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><MeshPage /></QueryClientProvider>));
}
async function refetch() {
  await act(async () => { await client.refetchQueries({ queryKey: ["mesh"] }); });
}

describe("Mesh Overview observation failures", () => {
  it.each([false, true])("hides retired configuration state (CP drift also fails: %s)", async (both) => {
    await mount();
    await settle(() => expect(host.textContent).toContain("xDS Convergence"));
    failConfig = true;
    failSlices = both;
    await refetch();
    await settle(() => expect(host.textContent).toContain("Mesh configuration refresh failed"));
    expect(client.getQueryData(["mesh", "configDrift"])).toEqual(config);
    expect(host.textContent).not.toContain("xDS Convergence");
    expect(host.textContent).not.toContain("Quarantine");
    expect(host.textContent).toContain("Last successful observation:");
    if (both) expect(host.textContent).toContain("Data plane convergence refresh failed");
    else expect(host.textContent).toContain("Data Plane Convergence (CP view)");
    failConfig = false;
    failSlices = false;
    await refetch();
    await settle(() => expect(host.textContent).toContain("xDS Convergence"));
    expect(host.textContent).not.toContain("refresh failed");
  });

  it("keeps current configuration visible when only CP convergence becomes unavailable", async () => {
    await mount();
    await settle(() => expect(host.textContent).toContain("Data Plane Convergence (CP view)"));
    failSlices = true;
    await refetch();
    await settle(() => expect(host.textContent).toContain("Data plane convergence refresh failed"));
    expect(host.textContent).toContain("xDS Convergence");
    expect(host.textContent).not.toContain("Data Plane Convergence (CP view)");
    failSlices = false;
    await refetch();
    await settle(() => expect(host.textContent).toContain("Data Plane Convergence (CP view)"));
  });

  it("distinguishes a first-load feature miss from a successful empty CP inventory", async () => {
    failConfig = true;
    failSlices = true;
    await mount();
    await settle(() => expect(host.textContent).toContain("Mesh configuration state unavailable"));
    expect(host.textContent).toContain("Data plane convergence unavailable");
    expect(host.textContent).not.toContain("Last successful observation:");
    failConfig = false;
    failSlices = false;
    await refetch();
    await settle(() => expect(host.textContent).toContain("0/0 converged"));
    expect(host.textContent).not.toContain("unavailable");
  });
});
