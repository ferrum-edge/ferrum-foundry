import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type {
  ClusterStatus,
  BackendCapabilitiesResponse,
  ConnectedDpNode,
  DataPlaneEgressPolicy,
} from "@/api/ops";
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
let fetchMock: ReturnType<typeof vi.fn>;

function cpTopology(connectedDataPlanes = 1): ClusterStatus {
  return {
    mode: "cp",
    connected_data_planes: connectedDataPlanes,
    connected_mesh_nodes: 0,
    mesh_nodes: [],
    data_planes: connectedDataPlanes === 0 ? [] : [{
      node_id: "historical-node",
      namespace: "default",
      version: "0.9.0",
      status: "online",
      connected_at: "2026-09-06T00:00:00Z",
      last_sync_at: "2026-09-06T00:00:00Z",
    }],
  };
}

function dpTopology(status: "online" | "offline" = "online"): ClusterStatus {
  return {
    mode: "dp",
    control_plane: {
      url: "https://cp.example.test",
      status,
      is_primary: true,
      config_diverged: false,
      config_divergence_recoveries_total: 0,
    },
  };
}

function standaloneTopology(): ClusterStatus {
  return { mode: "standalone", message: "Standalone gateway" };
}

function capabilityRequestCount(): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = input instanceof Request ? input.url : String(input);
    return new URL(url, "http://localhost").pathname.includes("backend-capabilities");
  }).length;
}

beforeEach(() => {
  topology = cpTopology();
  capabilities = { entries: [{
    key: "https|backend|443",
    plain_http: { h1: "supported", h2_tls: "unsupported", h3: "unknown" },
    grpc_transport: { h2_tls: "supported", h2c: "unsupported" },
    hbone: "unknown",
    last_probe_at_unix_secs: 1788652800,
  }] };
  failTopology = false;
  failCapabilities = false;
  fetchMock = vi.fn(async (request: Request) => {
    const isTopology = new URL(request.url).pathname.endsWith("/cluster");
    if (isTopology ? failTopology : failCapabilities) {
      return new Response("Unavailable", { status: 503, headers: { "retry-after": "0" } });
    }
    return Response.json(isTopology ? topology : capabilities);
  });
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", fetchMock);
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
    expect(host.textContent).toContain("belong to a data plane");
    expect(host.textContent).not.toContain("Re-probe All");
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
    topology = standaloneTopology();
    capabilities = { entries: [] };
    await refetch("cluster");
    await refetch("backendCapabilities");
    await expectText("STANDALONE MODE");
    await expectText("No backend probes yet");
  });

  it("retains and qualifies capability history after failed refresh", async () => {
    topology = standaloneTopology();
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
    topology = dpTopology(status);
    await mount();
    await expectText(`CP ${status}`);
    failTopology = true;
    await refetch("cluster");
    await expectText(`Last known CP ${status}`);
  });

  it("shows gRPC TLS independently of plain HTTP TLS and gRPC h2c", async () => {
    topology = standaloneTopology();
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

describe("Backend probe surface by gateway mode", () => {
  it.each([
    { count: 0, excerpt: "Connect Foundry to a data plane" },
    { count: 1, excerpt: "The connected data plane exposes probe results" },
    { count: 2, excerpt: "The 2 connected data planes expose probe results" },
  ])("explains probes are unsupported on a control plane with $count data plane(s)", async ({ count, excerpt }) => {
    topology = cpTopology(count);
    failCapabilities = true;
    await mount();
    await expectText("CONTROL PLANE");
    await expectText("Backend protocol probes belong to a data plane");
    expect(host.textContent).toContain(excerpt);
    expect(host.textContent).not.toContain("Backend capabilities unavailable");
    expect(host.textContent).not.toContain("Retry");
    expect(host.textContent).not.toContain("Re-probe All");
    expect(host.textContent).not.toContain("gRPC H2/TLS");
    expect(host.textContent).not.toContain("No backend probes yet");
    expect(capabilityRequestCount()).toBe(0);
  });

  it.each([
    { topology: standaloneTopology(), marker: "STANDALONE MODE" },
    { topology: dpTopology(), marker: "DATA PLANE" },
  ])("keeps the failed-read Retry state when $marker supports probing", async (variant) => {
    topology = variant.topology;
    failCapabilities = true;
    await mount();
    await expectText(variant.marker);
    await expectText("Backend capabilities unavailable. The request failed.");
    expect(host.textContent).toContain("Retry capabilities");
    expect(host.textContent).toContain("Re-probe All");
    expect(host.textContent).toContain("gRPC H2/TLS");
    expect(host.textContent).not.toContain("belong to a data plane");
    expect(capabilityRequestCount()).toBeGreaterThan(0);
  });
});

describe("Data-plane backend egress attestation (Edge v0.9.14)", () => {
  const publicOnly: DataPlaneEgressPolicy = {
    mode: "public",
    mode_allowed_ip_classes: ["public"],
    mode_blocked_ip_classes: ["private-reserved"],
    dangerous_ranges_blocked: true,
    allow_cidr_overrides_present: false,
    deny_cidr_overrides_present: false,
    public_only_guaranteed: true,
  };

  function stream(
    connectedAt: string,
    extra: Pick<ConnectedDpNode, "backend_egress_policy_attestation" | "backend_egress_policy">,
  ): ConnectedDpNode {
    return {
      node_id: "dp-shared",
      namespace: "default",
      version: "0.9.14",
      status: "online",
      connected_at: connectedAt,
      last_sync_at: connectedAt,
      ...extra,
    };
  }

  it("lists streams sharing a node_id and summarizes their self-reported policy", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    topology = {
      mode: "cp",
      connected_data_planes: 2,
      data_planes: [
        stream("2026-10-07T00:00:00Z", {
          backend_egress_policy_attestation: "reported",
          backend_egress_policy: publicOnly,
        }),
        stream("2026-10-07T00:00:05Z", {
          backend_egress_policy_attestation: "unknown",
          backend_egress_policy: null,
        }),
      ],
      data_plane_backend_egress_policy: {
        connected_data_planes: 2,
        reporting_data_planes: 1,
        unknown_data_planes: 1,
        weakest_policy: publicOnly,
        weakest_policy_complete: false,
        all_connected_public_only_guaranteed: false,
      },
      connected_mesh_nodes: 0,
      mesh_nodes: [],
    };
    try {
      await mount();
      await expectText("egress public · public-only");
      expect(host.textContent).toContain("egress policy unknown");
      expect(host.textContent!.split("dp-shared")).toHaveLength(3);
      expect(host.textContent).toContain("1 of 2 data plane(s) reported · 1 unknown");
      expect(host.textContent).toContain("weakest reported mode public (incomplete)");
      expect(host.textContent).toContain("public-only for every connected data plane: no");
      expect(host.textContent).toContain("not host attestation");
      expect(consoleError.mock.calls.flat().map(String).join(" ")).not.toContain("same key");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("qualifies the aggregate as last known after a failed refresh", async () => {
    topology = {
      ...(cpTopology() as Extract<ClusterStatus, { mode: "cp" }>),
      data_plane_backend_egress_policy: {
        connected_data_planes: 1,
        reporting_data_planes: 1,
        unknown_data_planes: 0,
        weakest_policy: publicOnly,
        weakest_policy_complete: true,
        all_connected_public_only_guaranteed: true,
      },
    };
    await mount();
    await expectText("public-only for every connected data plane: yes");
    failTopology = true;
    await refetch("cluster");
    await expectText("Backend egress in last known snapshot");
  });

  it("makes no egress claim when the response carries no attestation", async () => {
    await mount();
    await expectText("historical-node");
    expect(host.textContent).not.toContain("Backend egress");
    expect(host.textContent).not.toContain("egress policy unknown");
    expect(host.textContent).not.toContain("egress public");
  });
});
