import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { ClusterStatus, BackendCapabilitiesResponse } from "@/api/ops";
import ClusterPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "default" } }),
}));
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let topology: ClusterStatus;
let capabilities: BackendCapabilitiesResponse;
let failTopology: boolean;
let failCapabilities: boolean;

beforeEach(() => {
  topology = {
    mode: "cp",
    connected_data_planes: 1,
    connected_mesh_nodes: 0,
    mesh_nodes: [],
    data_planes: [{
      node_id: "historical-node",
      namespace: "default",
      version: "0.9.0",
      status: "online",
      connected_at: "2026-09-06T00:00:00Z",
      last_sync_at: "2026-09-06T00:00:00Z",
    }],
  };
  capabilities = { entries: [{
    key: "https|backend|443",
    plain_http: { h1: "supported", h2_tls: "unsupported", h3: "unknown" },
    grpc_transport: { h2_tls: "supported", h2c: "unsupported" },
    hbone: "unknown",
    last_probe_at_unix_secs: 1788652800,
  }] };
  failTopology = false;
  failCapabilities = false;
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const isTopology = new URL(request.url).pathname.endsWith("/cluster");
    if (isTopology ? failTopology : failCapabilities) {
      return new Response("Unavailable", { status: 503, headers: { "retry-after": "0" } });
    }
    return Response.json(isTopology ? topology : capabilities);
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

async function mount() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <ToastProvider><ClusterPage /></ToastProvider>
    </QueryClientProvider>,
  ));
}

async function expectText(text: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain(text);
  });
}

async function refetch(key: string) {
  await act(async () => { await client.refetchQueries({ queryKey: [key] }); });
}

describe("Cluster query snapshots", () => {
  it("marks retained topology as last known after terminal failure and recovers", async () => {
    await mount();
    await expectText("historical-node");
    const observedAt = client.getQueryState(["cluster"])!.dataUpdatedAt;
    failTopology = true;
    await refetch("cluster");
    await expectText("Topology refresh failed");
    expect(host.textContent).toContain("last known online");
    expect(host.textContent).toContain("connected in last known snapshot");
    expect(client.getQueryState(["cluster"])!.dataUpdatedAt).toBe(observedAt);
    failTopology = false;
    await refetch("cluster");
    await vi.waitFor(() => expect(host.textContent).not.toContain("Topology refresh failed"));
    expect(host.textContent).not.toContain("last known online");
  });

  it("distinguishes initial outages from successful empty inventories", async () => {
    failTopology = true;
    failCapabilities = true;
    await mount();
    await expectText("Cluster topology unavailable");
    await expectText("Backend capabilities unavailable");
    expect(host.textContent).not.toContain("No backend probes yet");
    failTopology = false;
    failCapabilities = false;
    topology = { mode: "standalone", message: "Standalone gateway" };
    capabilities = { entries: [] };
    await refetch("cluster");
    await refetch("backendCapabilities");
    await expectText("STANDALONE MODE");
    await expectText("No backend probes yet");
  });

  it("retains and qualifies capability history after failed refresh", async () => {
    await mount();
    await expectText("https · backend · 443");
    failCapabilities = true;
    await refetch("backendCapabilities");
    await expectText("Capabilities refresh failed");
    expect(host.textContent).toContain("Last known capabilities observed:");
    expect(host.textContent).toContain("https · backend · 443");
    expect(host.textContent).not.toContain("No backend probes yet");
    failCapabilities = false;
    await refetch("backendCapabilities");
    await vi.waitFor(() => expect(host.textContent).not.toContain("Capabilities refresh failed"));
  });

  it.each(["online", "offline"] as const)("keeps DP %s distinct from read failures", async (status) => {
    topology = { mode: "dp", control_plane: {
      url: "https://cp.example.test",
      status,
      is_primary: true,
      config_diverged: false,
      config_divergence_recoveries_total: 0,
    } };
    await mount();
    await expectText(`CP ${status}`);
    failTopology = true;
    await refetch("cluster");
    await expectText(`Last known CP ${status}`);
  });

  it("shows gRPC TLS independently of plain HTTP TLS and gRPC h2c", async () => {
    await mount();
    await expectText("https · backend · 443");
    const grids = host.querySelectorAll('[class*="grid-cols-"]');
    expect(grids[0]!.textContent).toContain("gRPC H2/TLS");
    const cells = grids[1]!.children;
    expect(cells[2]!.textContent).toBe("no");
    expect(cells[4]!.textContent).toBe("yes");
    expect(cells[5]!.textContent).toBe("no");
  });
});
