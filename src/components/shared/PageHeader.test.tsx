import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, settle } from "@/test/__tests__/harness";
import { PageHeader } from "./PageHeader";

let ui: ReturnType<typeof createHarness>;
beforeEach(() => { ui = createHarness(); });
afterEach(async () => ui.dispose());

async function mount(path: string) {
  // Flat sibling routes, as in the app's router.
  const root = createRootRoute();
  const list = createRoute({
    getParentRoute: () => root,
    path: "/proxies",
    component: () => <PageHeader title="Proxies" description="Every route" />,
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/proxies/$proxyId",
    component: () => (
      <PageHeader
        title="Orders API"
        meta="proxy-orders-api"
        breadcrumbs={[{ label: "Proxies", to: "/proxies" }, { label: "Orders API" }]}
        actions={<button type="button">Delete</button>}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([list, detail]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

describe("PageHeader", () => {
  it("renders the page's single h1 with description and no trail on a top-level page", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Metrics" description="Gateway traffic" actions={<button type="button">Refresh Now</button>} />,
    );
    expect(html).toContain("<h1");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Gateway traffic");
    expect(html).toContain("Refresh Now");
    expect(html).not.toContain('aria-label="Breadcrumb"');
  });

  it("stacks the actions under the text below the sm breakpoint", () => {
    const html = renderToStaticMarkup(<PageHeader title="Proxies" actions={<button type="button">Create Proxy</button>} />);
    const container = new DOMParser().parseFromString(html, "text/html").body.firstElementChild!;
    expect(container.classList.contains("flex-col")).toBe(true);
    expect(container.classList.contains("sm:flex-row")).toBe(true);
    const text = container.firstElementChild!;
    expect(text.classList.contains("min-w-0")).toBe(true);
    expect(text.classList.contains("flex-1")).toBe(true);
  });

  it("links a detail page back to its list and marks the current page", async () => {
    const router = await mount("/proxies/proxy-orders-api");
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Orders API"));
    const nav = ui.host.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]')!;
    expect(nav).not.toBeNull();
    expect(nav.textContent).toBe("Proxies/Orders API");
    const links = nav.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/proxies");
    // Only the current page is marked current, never the parent link.
    expect([...nav.querySelectorAll('[aria-current="page"]')].map((el) => el.textContent)).toEqual(["Orders API"]);
    expect(ui.host.textContent).toContain("proxy-orders-api");

    await act(async () => links[0].click());
    await settle(() => expect(router.state.location.pathname).toBe("/proxies"));
    expect(ui.host.querySelector("h1")?.textContent).toBe("Proxies");
    expect(ui.host.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
  });
});
