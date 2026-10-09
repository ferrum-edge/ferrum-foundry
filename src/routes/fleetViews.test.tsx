/* ------------------------------------------------------------------ */
/*  Metrics and Cluster read only fleet-global routes, which the BFF   */
/*  and Ferrum Edge v0.9.16+ refuse to a namespace-scoped session.     */
/*  Such a session reaching one by URL gets the reason and the page    */
/*  sends nothing; any other session gets the page. Mesh keeps its     */
/*  namespace-scoped Trust tab and withholds only the fleet tabs.      */
/* ------------------------------------------------------------------ */

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@/api/types";
import { FleetViewGate } from "@/components/shared/FleetViewGate";
import { CapabilityProvider } from "@/stores/capabilities";
import { createHarness, page, settle, stubFetch } from "@/test/__tests__/harness";
import ClusterPage from "./cluster/index";
import MeshPage from "./mesh/index";
import MetricsPage from "./metrics/index";

type Principal = { role: "admin"; namespaces?: string[] };

const { session } = vi.hoisted(() => ({
  session: { principal: null as Principal | null },
}));
const health: HealthResponse = {
  status: "ok",
  ready: true,
  mode: "database",
  admin_writes_enabled: true,
};

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: session.principal }) }));
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "tenant-a" }, selectedNamespace: "tenant-a" }),
}));
vi.mock("@/hooks/useMetrics", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useMetrics")>(),
  useHealth: () => ({
    data: health,
    isError: false,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: 1,
    error: null,
    refetch: async () => undefined,
  }),
}));

const PAGES: Array<[string, ComponentType, string, string]> = [
  ["Metrics", MetricsPage, "Metrics", "Gateway metrics are unavailable"],
  ["Cluster", ClusterPage, "Cluster", "Cluster status is unavailable"],
];

let ui: ReturnType<typeof createHarness>;
let requests: Request[];

beforeEach(() => {
  ui = createHarness();
  requests = [];
  session.principal = null;
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/proxy/gateway-trust-bundles") return Response.json(page([]));
    if (path === "/api/proxy/gateway-trust/status") return Response.json({ configured: false });
    return Response.json({}, { status: 404 });
  });
});

afterEach(async () => {
  await ui.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function notices(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-capability-blocked="namespace-scope"]')];
}

describe("fleet-wide views for a namespace-scoped session", () => {
  it.each(PAGES)("%s names the reason and sends no request", async (_label, Page, title, headline) => {
    session.principal = { role: "admin", namespaces: ["tenant-a"] };
    await ui.render(
      <CapabilityProvider>
        <Page />
      </CapabilityProvider>,
    );
    await settle(() => expect(notices()).toHaveLength(1));

    expect(document.querySelector("h1")?.textContent).toBe(title);
    expect(notices()[0].querySelector("p")?.textContent).toBe(headline);
    expect(notices()[0].textContent).toContain("namespace grants do not scope");
    expect(requests).toEqual([]);
  });

  it("keeps Mesh's namespace-scoped Trust tab and sends none of the fleet tabs' reads", async () => {
    session.principal = { role: "admin", namespaces: ["tenant-a"] };
    await ui.render(
      <CapabilityProvider>
        <MeshPage />
      </CapabilityProvider>,
    );
    await settle(() => expect(document.body.textContent).toContain("Mesh trust is not active in database mode"));

    expect(document.querySelector("h1")?.textContent).toBe("Mesh");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].querySelector("p")?.textContent).toBe("Mesh status is unavailable");
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Trust"]);
    // Only the namespace-scoped gateway trust reads, bound to the namespace.
    const paths = requests.map((request) => new URL(request.url).pathname);
    expect(new Set(paths)).toEqual(
      new Set(["/api/proxy/gateway-trust-bundles", "/api/proxy/gateway-trust/status"]),
    );
    expect(requests.every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
  });

  it("renders every Mesh tab for a session without namespace grants", async () => {
    session.principal = { role: "admin" };
    await ui.render(
      <CapabilityProvider>
        <MeshPage />
      </CapabilityProvider>,
    );
    await settle(() => expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8));

    expect(notices()).toEqual([]);
    expect(document.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Overview");
  });

  it.each<[string, Principal | null]>([
    ["an admin without namespace grants", { role: "admin" }],
    ["an unknown session", null],
  ])("renders the page itself for %s", async (_label, principal) => {
    session.principal = principal;
    await ui.render(
      <CapabilityProvider>
        <FleetViewGate view="cluster" title="Cluster">
          <p>cluster workspace</p>
        </FleetViewGate>
      </CapabilityProvider>,
    );
    await settle(() => expect(document.body.textContent).toContain("cluster workspace"));

    expect(notices()).toEqual([]);
    expect(document.querySelector("h1")).toBeNull();
  });
});
