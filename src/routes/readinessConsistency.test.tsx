import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/layout/Header";
import DashboardPage from "./dashboard";
import StatusPage from "./status";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "ferrum", setNamespace: vi.fn() }),
}));
vi.mock("@/hooks/useNamespaces", () => ({
  useNamespaces: () => ({ data: ["ferrum"], isSuccess: true, isFetching: false }),
}));
vi.mock("@/stores/theme", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }),
}));
vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ principal: null, logout: vi.fn() }),
}));
vi.mock("@/hooks/useMetrics", () => {
  const health = { data: { status: "ok", ready: true, mode: "database", database: { status: "connected" } }, isLoading: false, isError: false };
  const metrics = {
    data: { gateway: { proxy_count: 1, consumer_count: 2, upstream_count: 3, plugin_config_count: 4, uptime_seconds: 3600, ferrum_version: "test", total_requests: 0, status_codes_total: {} }, circuit_breakers: [], health_check: { unhealthy_targets: [] } },
    dataUpdatedAt: 1, isLoading: false, isError: false,
  };
  return { useHealth: () => health, useAdminMetrics: () => metrics };
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let state: "ready" | "degraded" | "unavailable";
let transportError: boolean;

beforeEach(() => {
  state = "unavailable";
  transportError = false;
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (transportError) throw new TypeError("Failed to fetch");
    return Response.json({
      status: state, ready: state !== "unavailable", version: "test", checkedAt: "2026-09-06T00:00:00Z",
      components: { bff: { status: "ok" }, gateway: { status: state === "ready" ? "ok" : state } },
    }, { status: state === "unavailable" ? 503 : 200 });
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

async function mount(Page: () => ReactElement | null) {
  function CombinedPage() { return <><Header onToggleSidebar={() => {}} /><main><Page /></main></>; }
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/view", component: CombinedPage });
  const router = createRouter({ routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/view"] }) });
  await act(async () => {
    await router.load();
    root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  });
}

function connectionCard() {
  const heading = [...host.querySelectorAll("h2")].find((entry) => entry.textContent === "Foundry connection")!;
  expect(heading).toBeTruthy();
  return heading.parentElement!;
}

async function refresh() {
  await act(async () => { await client.refetchQueries({ queryKey: ["bff-readiness"] }); });
}

describe("shared Foundry connection status", () => {
  it.each([["Dashboard", DashboardPage], ["Health Status", StatusPage]] as const)(
    "%s agrees with Header through unavailable, ready, transport failure, and recovery",
    async (_name, Page) => {
      await mount(Page);
      await settle(() => expect(connectionCard().textContent).toContain("Disconnected"));
      expect(host.querySelector("header")?.textContent).toContain("Disconnected");
      expect(connectionCard().textContent).not.toContain("Connected");
      expect(connectionCard().textContent).toContain("Go to Settings");
      expect(host.textContent).toContain("Gateway process health");
      expect(host.textContent).toContain("database");

      state = "ready";
      await refresh();
      await settle(() => expect(connectionCard().textContent).toContain("Connected"));
      expect(host.querySelector("header")?.textContent).toContain("Connected");
      transportError = true;
      await refresh();
      await settle(() => expect(connectionCard().textContent).toContain("Unreachable"));
      expect(host.querySelector("header")?.textContent).toContain("Unreachable");
      expect(connectionCard().textContent).not.toContain("Connected");
      expect(client.getQueryData(["bff-readiness"])).toMatchObject({ status: "ready" });

      transportError = false;
      state = "degraded";
      await refresh();
      await settle(() => expect(connectionCard().textContent).toContain("Degraded"));
      expect(host.querySelector("header")?.textContent).toContain("Degraded");
    },
  );
});
