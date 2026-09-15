import { act } from "react";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, settle } from "@/test/__tests__/harness";
import { Breadcrumb } from "./Breadcrumb";

let ui: ReturnType<typeof createHarness>;
beforeEach(() => { ui = createHarness(); });
afterEach(async () => ui.dispose());

async function mount(path: string) {
  const root = createRootRoute({ component: () => <><Breadcrumb /><Outlet /></> });
  const mesh = createRoute({ getParentRoute: () => root, path: "/mesh" });
  const egress = createRoute({ getParentRoute: () => mesh, path: "/egress", component: () => <h1>Egress view</h1> });
  const router = createRouter({
    routeTree: root.addChildren([mesh.addChildren([egress])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

describe("Breadcrumb route hierarchy", () => {
  it.each(["/", "/mesh"])("omits redundant navigation at %s", async (path) => {
    await mount(path);
    expect(ui.host.querySelector('[aria-label="Breadcrumb"]')).toBeNull();
  });

  it("labels parent links and the current page, and navigates to the parent", async () => {
    const router = await mount("/mesh/egress");
    await settle(() => expect(ui.host.textContent).toContain("Egress view"));
    const nav = ui.host.querySelector<HTMLElement>('[aria-label="Breadcrumb"]')!;
    expect(nav.textContent).toBe("Mesh/Egress");
    expect(nav.querySelectorAll("a")).toHaveLength(1);
    expect(nav.querySelector("a")?.getAttribute("href")).toBe("/mesh");
    // Native links, unlike form buttons, navigate through the router.
    const link = nav.querySelector<HTMLAnchorElement>("a")!;
    await act(async () => link.click());
    await settle(() => expect(router.state.location.pathname).toBe("/mesh"));
    expect(ui.host.querySelector('[aria-label="Breadcrumb"]')).toBeNull();
  });
});
