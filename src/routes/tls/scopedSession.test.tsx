/* ------------------------------------------------------------------ */
/*  A session holding namespace grants is refused every fleet TLS      */
/*  mutation by the BFF, so the TLS page presents create, delete,      */
/*  ACME, and rotation controls read-only, with the reason, while      */
/*  reads and stateless validation stay available (issue #565).        */
/* ------------------------------------------------------------------ */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTlsRecord } from "@/api/tls";
import type { HealthResponse } from "@/api/types";
import { CapabilityProvider } from "@/stores/capabilities";
import { button, createHarness, panel, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import TlsPage from "./index";

type Principal = {
  subject: string;
  displayName: string;
  role: "operator" | "admin";
  namespaces?: string[];
  authMode: "trusted-proxy";
};

const { session } = vi.hoisted(() => ({ session: { principal: null as Principal | null } }));
const health: HealthResponse = {
  status: "ok",
  ready: true,
  mode: "database",
  admin_writes_enabled: true,
};

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: session.principal }) }));
vi.mock("@/hooks/useMetrics", () => ({
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

const at = "2026-09-01T00:00:00Z";
const record: ManagedTlsRecord = {
  id: "edge-cert", name: "Edge Certificate", kind: "certificate",
  source_uri: "managed://certificates/edge-cert", subject: "CN=api.example.test",
  not_after: "2026-11-01T00:00:00Z", certificate_count: 1, created_at: at, updated_at: at,
};

let ui: ReturnType<typeof createHarness>;
let requests: Request[];

function signIn(role: Principal["role"], namespaces?: string[]) {
  session.principal = {
    subject: "tls-user",
    displayName: "TLS user",
    role,
    ...(namespaces === undefined ? {} : { namespaces }),
    authMode: "trusted-proxy",
  };
}

beforeEach(() => {
  ui = createHarness();
  requests = [];
  session.principal = null;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  stubFetch(async (request) => {
    requests.push(request);
    if (request.method !== "GET") throw new Error(`Unexpected TLS mutation: ${request.method}`);
    const url = new URL(request.url);
    const path = url.pathname.replace("/api/proxy/admin/tls/", "");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const data = path === "certificates" ? [record] : [];
    return Response.json({ data, pagination: { offset, limit, total: data.length } });
  });
});

afterEach(async () => {
  await ui.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount() {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/tls", component: TlsPage });
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/tls"] }),
  });
  await router.load();
  await ui.render(
    <CapabilityProvider>
      <RouterProvider router={router} />
    </CapabilityProvider>,
  );
  await settle(() => expect(panel().textContent).toContain("No TLS material found"));
}

function notices(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-capability-blocked="namespace-scope"]')];
}

describe("TLS page for a namespace-scoped session", () => {
  it("disables fleet TLS create, delete, ACME, and rotation for a scoped admin", async () => {
    signIn("admin", ["tenant-a"]);
    await mount();

    const headlines = notices().map((notice) => notice.querySelector("p")?.textContent);
    // One notice for both: the reason is the same.
    expect(headlines).toEqual(["Managed TLS material and rotation are read-only"]);
    for (const notice of notices()) {
      expect(notice.textContent).toContain("namespace grants do not scope");
    }
    expect(button("Rotate Now", panel()).disabled).toBe(true);

    await selectTab("Certificates");
    await settle(() => expect(panel().textContent).toContain("Edge Certificate"));
    expect(button("Add Certificate", panel()).disabled).toBe(true);
    expect(button("Delete certificate Edge Certificate", panel()).disabled).toBe(true);

    await selectTab("ACME");
    await settle(() => expect(panel().textContent).toContain("No ACME certificates"));
    expect(button("Import Certificate", panel()).disabled).toBe(true);
    expect(button("New ACME Order", panel()).disabled).toBe(true);

    // Validation persists nothing and the BFF allows it to a scoped session.
    await selectTab("Validate");
    expect(button("Validate", panel()).disabled).toBe(false);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("names rotation separately for a scoped operator, whose role already withholds material", async () => {
    signIn("operator", ["tenant-a"]);
    await mount();

    expect(notices().map((notice) => notice.querySelector("p")?.textContent))
      .toEqual(["TLS rotation is unavailable"]);
    const material = document.querySelector<HTMLElement>('[data-capability-blocked="role"]');
    expect(material?.textContent).toContain("Managed TLS material is read-only");
    expect(button("Rotate Now", panel()).disabled).toBe(true);
  });

  it("keeps every fleet TLS control for an admin without namespace grants", async () => {
    signIn("admin");
    await mount();

    expect(document.querySelector("[data-capability-blocked]")).toBeNull();
    expect(button("Rotate Now", panel()).disabled).toBe(false);
    await selectTab("Certificates");
    await settle(() => expect(panel().textContent).toContain("Edge Certificate"));
    expect(button("Add Certificate", panel()).disabled).toBe(false);
    expect(button("Delete certificate Edge Certificate", panel()).disabled).toBe(false);
  });
});
