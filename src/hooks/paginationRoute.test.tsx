import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  parseSearchWith,
  RouterProvider,
} from "@tanstack/react-router";
import ProxiesPage from "@/routes/proxies/index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" } }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = new URL(input, "http://localhost").toString();
    }
    super(input, init);
  }
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  queryClient?.clear();
  vi.unstubAllGlobals();
});

it("normalizes /proxies?offset=-20&limit=20 and requests only offset zero", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      requests.push(url);
      return new Response(
        JSON.stringify({
          data: [],
          pagination: { offset: 0, limit: 20, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const history = createMemoryHistory({
    initialEntries: ["/proxies?offset=-20&limit=20"],
  });
  const rootRoute = createRootRoute();
  const proxiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/proxies",
    component: ProxiesPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([proxiesRoute]),
    history,
    parseSearch: parseSearchWith(JSON.parse),
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });

  await act(async () => {
    await vi.waitFor(() => {
      expect(history.location.search).toBe("?offset=0&limit=20");
      expect(
        requests.some((url) => url.pathname === "/api/proxy/proxies"),
      ).toBe(true);
    });
  });
  const proxyRequests = requests.filter(
    (url) => url.pathname === "/api/proxy/proxies",
  );
  for (const url of proxyRequests) {
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("limit")).toBe("20");
  }
});
