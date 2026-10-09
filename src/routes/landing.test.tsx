import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, settle } from "@/test/__tests__/harness";
import LandingPage from "./landing";

const { auth } = vi.hoisted(() => ({
  auth: { principal: null as { role: string; namespaces?: string[] } | null },
}));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: auth.principal }) }));
// The Dashboard's own reads are not under test; only which page "/" renders.
vi.mock("@/routes/dashboard/index", () => ({ default: () => <h1>Dashboard</h1> }));

let ui: ReturnType<typeof createHarness>;

beforeEach(() => {
  auth.principal = null;
  ui = createHarness();
});
afterEach(async () => ui.dispose());

async function land() {
  const root = createRootRoute({ component: Outlet });
  const landing = createRoute({ getParentRoute: () => root, path: "/", component: LandingPage });
  const proxies = createRoute({
    getParentRoute: () => root,
    path: "/proxies",
    component: () => <h1>Proxies</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([landing, proxies]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    // As in the app router: a pending component wraps each route in Suspense,
    // which the lazily loaded Dashboard needs.
    defaultPendingComponent: () => null,
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

describe("landing route", () => {
  it("sends a session holding namespace grants to its proxies instead of the Dashboard", async () => {
    auth.principal = { role: "admin", namespaces: ["tenant-a"] };
    const router = await land();
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Proxies"));
    expect(router.state.location.pathname).toBe("/proxies");
    expect(ui.host.textContent).not.toContain("Dashboard");
    // The redirect replaces "/", so Back does not return to a refused page.
    expect(router.history.length).toBe(1);
  });

  it("shows an unrestricted session the Dashboard", async () => {
    auth.principal = { role: "admin" };
    const router = await land();
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Dashboard"));
    expect(router.state.location.pathname).toBe("/");
  });
});
