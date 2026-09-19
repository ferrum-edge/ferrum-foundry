import type { ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Consumer, PluginConfig, Proxy, Upstream } from "@/api/types";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { createHarness, page, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import { graph, meshResponses } from "@/test/__tests__/meshFixtures";
import ProxiesPage from "./proxies";
import UpstreamsPage from "./upstreams";
import ConsumersPage from "./consumers";
import PluginsPage from "./plugins";
import ClusterPage from "./cluster";
import MeshPage from "./mesh";
import TlsPage from "./tls";
import ProxyDetailPage from "./proxies/$proxyId";
import ConsumerDetailPage from "./consumers/$consumerId";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "tenant-a" } }),
}));

const at = "2026-09-01T00:00:00Z";
const proxy: Proxy = {
  id: "orders", name: "Orders API", listen_path: "/orders", hosts: [],
  backend_scheme: "http", backend_host: "orders.example.test", backend_port: 8080,
  strip_listen_path: false, preserve_host_header: false,
  backend_connect_timeout_ms: 5000, backend_read_timeout_ms: 5000,
  backend_write_timeout_ms: 5000, backend_tls_verify_server_cert: true,
  auth_mode: "single", frontend_tls: false, passthrough: false,
  udp_idle_timeout_seconds: 60, allowed_ws_origins: [], response_body_mode: "stream",
  plugins: [], created_at: at, updated_at: at,
};
const consumer: Consumer = {
  id: "operator", username: "Orders operator", custom_id: "orders-team",
  acl_groups: ["orders"], credentials: { keyauth: [{ key: "[REDACTED]" }] },
  created_at: at, updated_at: at,
};
const plugin: PluginConfig = {
  id: "global-key-auth", plugin_name: "key_auth", scope: "global",
  enabled: true, config: {}, created_at: at, updated_at: at,
};
const upstream: Upstream = {
  id: "orders-pool", name: "Orders pool", algorithm: "weighted_round_robin",
  targets: [], created_at: at, updated_at: at,
};

interface Surface {
  label: string;
  Page: () => ReactElement;
  path: string;
  identity: string;
  minWidth: string;
  entry?: string;
  tab?: string;
  empty?: string;
  endpoint?: string;
}

const lists: Surface[] = [
  { label: "Proxies", Page: ProxiesPage, path: "/proxies", identity: proxy.name!,
    minWidth: "min-w-[52rem]", empty: "No proxies yet", endpoint: "proxies" },
  { label: "Upstreams", Page: UpstreamsPage, path: "/upstreams", identity: upstream.name!,
    minWidth: "min-w-[52rem]", empty: "No upstreams yet", endpoint: "upstreams" },
  { label: "Consumers", Page: ConsumersPage, path: "/consumers", identity: consumer.username,
    minWidth: "min-w-[52rem]", empty: "No consumers yet", endpoint: "consumers" },
  { label: "Plugins", Page: PluginsPage, path: "/plugins", identity: plugin.id,
    minWidth: "min-w-[52rem]", empty: "No plugin configs yet", endpoint: "plugins/config" },
  { label: "Backend capabilities", Page: ClusterPage, path: "/cluster", identity: "https · orders.example.test · 443",
    minWidth: "min-w-[48rem]", empty: "No backend probes yet" },
  { label: "Mesh service graph", Page: MeshPage, path: "/mesh", identity: "frontend-7d9",
    minWidth: "min-w-[52rem]", tab: "Service Graph", empty: "No traffic observed" },
  { label: "TLS inventory", Page: TlsPage, path: "/tls", identity: "CN=orders.example.test",
    minWidth: "min-w-[52rem]", empty: "No TLS material found" },
];
const details: Surface[] = [
  { label: "Authorized consumers", Page: ProxyDetailPage, path: "/proxies/$proxyId",
    entry: "/proxies/orders", identity: consumer.username, minWidth: "min-w-[40rem]", tab: "Consumers" },
  { label: "Authorized proxies", Page: ConsumerDetailPage, path: "/consumers/$consumerId",
    entry: "/consumers/operator", identity: proxy.name!, minWidth: "min-w-[40rem]", tab: "Matched Proxies (1)" },
];

let ui: ReturnType<typeof createHarness>;
let empty: boolean;
let failure: string | undefined;

beforeEach(() => {
  ui = createHarness();
  empty = false;
  failure = undefined;
  stubFetch((request) => {
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    if (path === failure) return Response.json({ error: "Unavailable" }, { status: 400 });
    const responses: Record<string, unknown> = {
      ...meshResponses,
      proxies: page(empty ? [] : [proxy]),
      upstreams: page(empty ? [] : [upstream]),
      consumers: page(empty ? [] : [consumer]),
      "plugins/config": page(empty ? [] : [plugin]),
      "proxies/orders": proxy,
      "consumers/operator": consumer,
      "api-specs": { items: [], total: 0, limit: 2, offset: 0, next_offset: null },
      cluster: { mode: "standalone", message: "Standalone gateway" },
      "backend-capabilities": { entries: empty ? [] : [{
        key: "https|orders.example.test|443",
        plain_http: { h1: "supported", h2_tls: "supported", h3: "unknown" },
        grpc_transport: { h2_tls: "supported", h2c: "unknown" }, hbone: "unknown",
        last_probe_at_unix_secs: 1788220800,
      }] },
      "mesh/service-graph": { ...graph, edges: empty ? [] : graph.edges, edge_count: empty ? 0 : 1 },
      "admin/tls/inventory": page(empty ? [] : [{
        id: "orders-cert", subject: "CN=orders.example.test", material_kind: "certificate",
        state: "loaded", used_by: [],
        source: { kind: "managed", identifier: "managed://certificates/orders-cert", refreshable: true },
      }]),
    };
    if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
    return Response.json(responses[path]);
  });
});

afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

async function mount(surface: Surface) {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: surface.path, component: surface.Page });
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [surface.entry ?? surface.path] }),
  });
  await router.load();
  await ui.render(<TooltipProvider><RouterProvider router={router} /></TooltipProvider>);
  if (surface.tab) {
    await settle(() => expect([...ui.host.querySelectorAll('[role="tab"]')]
      .some((tab) => tab.textContent === surface.tab)).toBe(true));
    await selectTab(surface.tab);
  }
}

function scrollRegion(surface: Surface) {
  const region = ui.host.querySelector<HTMLElement>(`[role="region"][aria-label="${surface.label}"]`);
  expect(region).not.toBeNull();
  expect(region!.classList.contains("overflow-x-auto")).toBe(true);
  expect(region!.classList.contains("max-w-full")).toBe(true);
  expect(region!.tabIndex).toBe(0);
  expect(region!.parentElement!.classList.contains("overflow-hidden")).toBe(true);
  expect(region!.parentElement!.classList.contains("min-w-0")).toBe(true);
  const canvas = region!.firstElementChild!;
  expect(canvas.classList.contains(surface.minWidth)).toBe(true);
  expect(canvas.classList.contains("w-full")).toBe(true);
  return { region: region!, canvas };
}

// jsdom has no layout engine. These assertions protect the actual rendered
// scroll containment and sizing contract; they do not claim pixel visibility.
describe("responsive resource grid structure", () => {
  it.each([...lists, ...details])("keeps $label headers and populated rows on one scrollable canvas", async (surface) => {
    await mount(surface);
    await settle(() => {
      const region = ui.host.querySelector(`[role="region"][aria-label="${surface.label}"]`);
      expect(region?.textContent).toContain(surface.identity);
    });
    const { region, canvas } = scrollRegion(surface);
    const grids = [...canvas.querySelectorAll<HTMLElement>(".grid")];
    expect(grids).toHaveLength(2);
    const template = [...grids[0].classList].find((name) => name.startsWith("grid-cols-["));
    expect(template).toBeTruthy();
    expect(grids[1].classList.contains(template!)).toBe(true);
    expect(grids[1].children).toHaveLength(grids[0].children.length);
    expect(grids[1].children[0].textContent).toContain(surface.identity);
    expect(grids.every((grid) => grid.closest('[role="region"]') === region)).toBe(true);
  });

  it.each(lists)("keeps $label empty headers scrollable and empty feedback within the card width", async (surface) => {
    empty = true;
    await mount(surface);
    await settle(() => expect(ui.host.textContent).toContain(surface.empty));
    const { region, canvas } = scrollRegion(surface);
    expect(canvas.querySelectorAll(".grid")).toHaveLength(1);
    expect(region.textContent).not.toContain(surface.empty);
    expect(region.parentElement!.textContent).toContain(surface.empty);
  });

  it.each(lists.filter((surface) => surface.endpoint))("keeps $label error feedback outside the wide canvas", async (surface) => {
    failure = surface.endpoint;
    await mount(surface);
    const message = `Failed to load ${surface.label.toLowerCase()}`;
    await settle(() => expect(ui.host.textContent).toContain(message));
    const { region } = scrollRegion(surface);
    expect(region.textContent).not.toContain(message);
    expect(region.parentElement!.textContent).toContain(message);
  });
});
