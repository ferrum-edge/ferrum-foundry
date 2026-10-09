/* ------------------------------------------------------------------ */
/*  A session holding namespace grants is refused every               */
/*  `/admin/tls/*` route, reads and validation included: by the BFF's */
/*  namespace route ceiling, and by Ferrum Edge v0.9.16+ for an       */
/*  `ns`-claim JWT (ferrum-edge#6093). The TLS page names the reason  */
/*  instead of its tabs and reads nothing.                            */
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
  role: "viewer" | "operator" | "admin";
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
}

function notices(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-capability-blocked="namespace-scope"]')];
}

describe("TLS page for a namespace-scoped session", () => {
  it.each(["viewer", "operator", "admin"] as const)(
    "names the reason instead of any TLS read or control for a scoped %s",
    async (role) => {
      signIn(role, ["tenant-a"]);
      await mount();
      await settle(() => expect(notices()).toHaveLength(1));

      const [notice] = notices();
      expect(notice.querySelector("p")?.textContent).toBe("TLS management is unavailable");
      expect(notice.textContent).toContain("namespace grants do not scope");
      expect(document.querySelector("h1")?.textContent).toBe("TLS Management");
      expect(document.querySelector('[role="tablist"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Rotate Now");
      expect(document.body.textContent).not.toContain("Validate");
      expect(requests).toEqual([]);
    },
  );

  it("keeps every fleet TLS read and control for an admin without namespace grants", async () => {
    signIn("admin");
    await mount();
    await settle(() => expect(panel().textContent).toContain("No TLS material found"));

    expect(document.querySelector("[data-capability-blocked]")).toBeNull();
    expect(button("Rotate Now", panel()).disabled).toBe(false);
    await selectTab("Certificates");
    await settle(() => expect(panel().textContent).toContain("Edge Certificate"));
    expect(button("Add Certificate", panel()).disabled).toBe(false);
    expect(button("Delete certificate Edge Certificate", panel()).disabled).toBe(false);
    await selectTab("Validate");
    expect(button("Validate", panel()).disabled).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("keeps the role notices for an operator without namespace grants", async () => {
    signIn("operator");
    await mount();
    await settle(() => expect(panel().textContent).toContain("No TLS material found"));

    expect(notices()).toEqual([]);
    const material = document.querySelector<HTMLElement>('[data-capability-blocked="role"]');
    expect(material?.textContent).toContain("Managed TLS material is read-only");
    expect(button("Rotate Now", panel()).disabled).toBe(false);
  });
});
