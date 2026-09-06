import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import ProxiesPage from "./proxies";
import ConsumersPage from "./consumers";
import UpstreamsPage from "./upstreams";
import PluginsPage from "./plugins";
import ApiSpecsPage from "./api-specs";
import TlsPage from "./tls";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "tenant-a" } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let total: number;
let requests: URL[];

beforeEach(() => {
  total = 15;
  requests = [];
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    requests.push(url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    // Auxiliary all-resource queries are empty. The bookmarked page is beyond
    // a known collection; after recovery the fixture collection is now empty.
    const responseTotal = offset === 100 ? total : 0;
    return Response.json(url.pathname.endsWith("/api-specs")
      ? { items: [], total: responseTotal, offset, limit, next_offset: null }
      : { data: [], pagination: { total: responseTotal, offset, limit } });
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

async function mount(Page: () => ReactElement) {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/list", component: Page });
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/list?offset=100&limit=20"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<QueryClientProvider client={client}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
  });
  return router;
}

const pages = [
  ["proxies", ProxiesPage, "No proxies yet", "/proxies"],
  ["consumers", ConsumersPage, "No consumers yet", "/consumers"],
  ["upstreams", UpstreamsPage, "No upstreams yet", "/upstreams"],
  ["plugins", PluginsPage, "No plugin configs yet", "/plugins/config"],
  ["API specs", ApiSpecsPage, "No API specs yet", "/api-specs"],
  ["TLS inventory", TlsPage, "No TLS material found", "/admin/tls/inventory"],
] as const;

describe("bookmarked pagination beyond the live total", () => {
  it.each(pages)("offers recovery for %s without first-run empty copy", async (_name, Page, emptyTitle, endpoint) => {
    const router = await mount(Page);
    await settle(() => expect(host.textContent).toContain("Page out of range"));
    expect(host.textContent).toContain("No results on this page");
    expect(host.textContent).not.toContain(emptyTitle);
    expect(host.textContent).not.toContain("Showing 101-15");
    const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Go to last page")!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    await settle(() => {
      expect(router.state.location.search).toMatchObject({ offset: 0, limit: 20 });
      expect(requests.some((url) => url.pathname.endsWith(endpoint) && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "20")).toBe(true);
    });
  });

  it.each(pages)("preserves the real empty state for %s", async (_name, Page, emptyTitle) => {
    total = 0;
    await mount(Page);
    await settle(() => expect(host.textContent).toContain(emptyTitle));
    expect(host.textContent).not.toContain("Page out of range");
  });
});
