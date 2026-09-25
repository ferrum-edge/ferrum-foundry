/* ------------------------------------------------------------------ */
/*  Ordinary navigation must not download the namespace (issue #382).  */
/* ------------------------------------------------------------------ */

/**
 * These are request-count assertions, not rendering assertions. A virtualized
 * table that still fetches every record does not satisfy the issue, so what is
 * measured here is the exact set of gateway calls a page makes against a
 * namespace far larger than one screen.
 *
 * The fixture sizes are deliberately above every budget in `pagination.ts`, so
 * a regression that reinstates a whole-collection scan changes these numbers
 * rather than merely making the suite slower.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { SUMMARY_SCAN_BUDGET } from "@/api/pagination";
import type { Proxy, Upstream, PluginConfig } from "@/api/types";

const PROXY_COUNT = 5_000;
const UPSTREAM_COUNT = 3_000;
const PLUGIN_COUNT = SUMMARY_SCAN_BUDGET + 500;
const PAGE_SIZE = 20;

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ offset: 0, limit: PAGE_SIZE }),
  useParams: () => ({ proxyId: "proxy-0" }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/shared/ProxyApiSpecsCard", () => ({
  ProxyApiSpecsCard: () => null,
}));
vi.mock("@/stores/capabilities", () => ({
  useCapabilities: () => ({
    capabilities: { proxies: { allowed: true, reason: null } },
  }),
}));

const { default: ProxiesPage } = await import("./index");
const { default: ProxyDetailPage } = await import("./$proxyId");

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function proxyAt(index: number): Proxy {
  return {
    id: `proxy-${index}`,
    namespace: "tenant-a",
    name: `proxy-${index}`,
    hosts: [],
    listen_path: `/p/${index}`,
    backend_scheme: "https",
    backend_host: "backend.internal",
    backend_port: 8443,
    // Every row references its own upstream: the worst case for per-row
    // resolution, and the case the old whole-catalog load was hiding.
    upstream_id: `upstream-${index}`,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 2000,
    backend_read_timeout_ms: 5000,
    backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 30,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function upstreamAt(index: number): Upstream {
  return {
    id: `upstream-${index}`,
    namespace: "tenant-a",
    name: `upstream ${index}`,
    algorithm: "round_robin",
    targets: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function pluginAt(index: number): PluginConfig {
  return {
    id: `plugin-${index}`,
    namespace: "tenant-a",
    plugin_name: "rate_limiting",
    scope: "proxy",
    proxy_id: `proxy-${index}`,
    config: {},
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function pageOf<T>(build: (index: number) => T, total: number, offset: number, limit: number) {
  const end = Math.min(offset + limit, total);
  return {
    data: Array.from({ length: Math.max(0, end - offset) }, (_, i) => build(offset + i)),
    pagination: { offset, limit, total },
  };
}

let calls: string[] = [];
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function countOf(pattern: RegExp): number {
  return calls.filter((call) => pattern.test(call)).length;
}

async function render(ui: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NamespaceProvider>{ui}</NamespaceProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("bounded loading on ordinary navigation", () => {
  beforeEach(() => {
    calls = [];
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        const url = new URL(input.url);
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? String(PAGE_SIZE));
        const proxyFilter = url.searchParams.get("proxy_id");
        calls.push(
          `${input.method} ${url.pathname}?offset=${offset}&limit=${limit}` +
            (proxyFilter === null ? "" : `&proxy_id=${proxyFilter}`),
        );

        if (url.pathname === "/api/proxy/proxies") {
          return Response.json(pageOf(proxyAt, PROXY_COUNT, offset, limit));
        }
        if (url.pathname === "/api/proxy/upstreams") {
          return Response.json(pageOf(upstreamAt, UPSTREAM_COUNT, offset, limit));
        }
        if (url.pathname === "/api/proxy/plugins/config" && proxyFilter !== null) {
          // Edge v0.9.7 paginates the filtered set: pluginAt(n) targets proxy-n.
          const index = Number(proxyFilter.replace("proxy-", ""));
          const matches = index < PLUGIN_COUNT ? [pluginAt(index)] : [];
          return Response.json({
            data: matches.slice(offset, offset + limit),
            pagination: { offset, limit, total: matches.length },
          });
        }
        if (url.pathname === "/api/proxy/plugins/config") {
          return Response.json(pageOf(pluginAt, PLUGIN_COUNT, offset, limit));
        }
        if (url.pathname.startsWith("/api/proxy/upstreams/")) {
          const id = url.pathname.split("/").pop()!;
          return Response.json(upstreamAt(Number(id.replace("upstream-", ""))));
        }
        if (url.pathname.startsWith("/api/proxy/proxies/")) {
          const id = url.pathname.split("/").pop()!;
          return Response.json(proxyAt(Number(id.replace("proxy-", ""))));
        }
        if (url.pathname === "/api/proxy/consumers") {
          return Response.json(pageOf(() => ({}), 0, offset, limit));
        }
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 500 });
      }),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens the first proxy page without traversing any collection", async () => {
    await render(<ProxiesPage />);

    // One page of proxies. Not 250 pages of 5,000 records.
    expect(calls.filter((call) => call.startsWith("GET /api/proxy/proxies?"))).toEqual([
      `GET /api/proxy/proxies?offset=0&limit=${PAGE_SIZE}`,
    ]);

    // Upstream names: one catalog page, then at most one read per visible row.
    const catalogPages = countOf(/GET \/api\/proxy\/upstreams\?/);
    const rowReads = countOf(/GET \/api\/proxy\/upstreams\/upstream-\d+/);
    expect(catalogPages).toBe(1);
    expect(rowReads).toBeLessThanOrEqual(PAGE_SIZE);
    // 3,000 upstreams would have been 12 sequential pages under the old load.
    expect(catalogPages + rowReads).toBeLessThan(Math.ceil(UPSTREAM_COUNT / 250));

    // The plugin summary stops at its budget instead of traversing 2,500.
    const pluginPages = countOf(/GET \/api\/proxy\/plugins\/config\?/);
    expect(pluginPages).toBeLessThanOrEqual(Math.ceil(SUMMARY_SCAN_BUDGET / 250));
    expect(pluginPages * 250).toBeLessThan(PLUGIN_COUNT);
  });

  it("reports an over-budget plugin count as unavailable, never as a smaller number", async () => {
    await render(<ProxiesPage />);

    const cells = [...host.querySelectorAll("span")].filter(
      (span) => span.textContent === "n/a",
    );
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]!.getAttribute("title")).toContain(
      `more than ${SUMMARY_SCAN_BUDGET} plugin configurations`,
    );
    // No badge claims a count derived from a partial traversal.
    expect(host.textContent).not.toContain("Counting effective plugins");
  });

  it("opens one proxy without starting the plugin or consumer traversals", async () => {
    await render(<ProxyDetailPage />);

    // Exactly the proxy itself. Not the plugin collection, not the consumer
    // collection, not even the linked upstream until its tab is asked for.
    expect(calls).toEqual(["GET /api/proxy/proxies/proxy-0?offset=0&limit=20"]);
    expect(countOf(/plugins\/config/)).toBe(0);
    expect(countOf(/consumers/)).toBe(0);
    expect(countOf(/upstreams/)).toBe(0);
  });

  it("starts the policy traversal only when its tab is opened", async () => {
    await render(<ProxyDetailPage />);
    expect(countOf(/plugins\/config/)).toBe(0);

    const pluginsTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.startsWith("Plugins"),
    )!;
    await act(async () => {
      pluginsTab.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    await settle();

    // The policy answer is an authorization conclusion, so this traversal is
    // complete by design — it just does not happen before it is asked for.
    expect(countOf(/plugins\/config\?offset=\d+&limit=\d+$/)).toBeGreaterThan(0);
    // And the consumer traversal still waits for its own tab.
    expect(countOf(/\/api\/proxy\/consumers/)).toBe(0);
  });

  it("lists what targets this proxy from one filtered read, not the namespace", async () => {
    await render(<ProxyDetailPage />);
    const pluginsTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.startsWith("Plugins"),
    )!;
    await act(async () => {
      pluginsTab.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    await settle();

    // One request for this proxy's configurations, whatever the namespace size.
    expect(calls.filter((call) => call.includes("proxy_id="))).toEqual([
      "GET /api/proxy/plugins/config?offset=0&limit=250&proxy_id=proxy-0",
    ]);
    // plugin-0 names proxy-0, which does not list it: it targets but never runs.
    expect(host.textContent).toContain("Targeting this proxy, not running");
    expect(host.textContent).toContain("plugin-0");
    expect(host.textContent).toContain("Not attached");
  });

  it("opening the upstream tab loads it without flashing a failure", async () => {
    await render(<ProxyDetailPage />);
    expect(countOf(/upstreams/)).toBe(0);

    const upstreamTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.startsWith("Upstream"),
    )!;
    await act(async () => {
      upstreamTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    // The read has only just been enabled. A deferred query must render as
    // loading here, never as a failed read.
    expect(host.textContent).not.toContain("Failed to load upstream data");

    await settle();
    expect(countOf(/GET \/api\/proxy\/upstreams\/upstream-0/)).toBe(1);
    expect(host.textContent).toContain("upstream 0");
  });
});
