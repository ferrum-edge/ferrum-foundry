import { act } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream, UpstreamCreate } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { button, click, createHarness, fill, page, panel, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import UpstreamDetailPage from "./$upstreamId";
import UpstreamNewPage from "./new";
import UpstreamsPage from "./index";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));
let ui: ReturnType<typeof createHarness>;
let current: Upstream | undefined;
let failure: boolean;
let writes: Request[];
const initial: Upstream = {
  id: "orders", name: "Orders", namespace: "tenant-a", algorithm: "round_robin",
  targets: [{ host: "old-backend", port: 8080, weight: 1, path: "/v1", tags: { version: "v1" } }],
  backend_tls_sni: "orders.internal", labels: { owner: "payments" },
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

/** A strong tag that changes whenever the stored upstream does. */
function etagOf(upstream: Upstream): string {
  let hash = 0;
  for (const char of JSON.stringify(upstream)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `"${(hash >>> 0).toString(16)}"`;
}

beforeEach(() => {
  ui = createHarness();
  current = initial;
  failure = false;
  writes = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (path === "/api/proxy/upstreams") return Response.json(page(current ? [current] : []));
      if (path === "/api/proxy/upstreams/orders") return current
        ? Response.json(current, { headers: { ETag: etagOf(current) } })
        : Response.json({ error: "upstream missing" }, { status: 404 });
      throw new Error(`Unexpected upstream read: ${path}`);
    }
    writes.push(request);
    if (failure) return Response.json({ error: "target policy rejected" }, { status: 400 });
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch !== null && (!current || ifMatch !== etagOf(current))) {
      return Response.json({ error: "precondition failed" }, { status: 412 });
    }
    if (request.method === "DELETE") {
      current = undefined;
      return new Response(null, { status: 204 });
    }
    const payload = await request.clone().json() as UpstreamCreate;
    current = { ...initial, ...payload, id: "orders" };
    return Response.json(current);
  });
});
afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(path = "/upstreams/orders") {
  const parent = createRootRoute();
  const detail = createRoute({ getParentRoute: () => parent, path: "/upstreams/$upstreamId", component: UpstreamDetailPage });
  const create = createRoute({ getParentRoute: () => parent, path: "/upstreams/new", component: UpstreamNewPage });
  const list = createRoute({ getParentRoute: () => parent, path: "/upstreams", component: UpstreamsPage });
  const router = createRouter({
    routeTree: parent.addChildren([detail, create, list]), history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

function rowActions() {
  return [...panel().querySelectorAll<HTMLButtonElement>("button")]
    .filter((entry) => entry.textContent?.trim() === "");
}

describe("upstream target route integration", () => {
  it("creates an upstream from an inline target and opens the resulting editor", async () => {
    const router = await mount("/upstreams/new");
    await fill(inputByLabel(ui.host, "Name"), "Created upstream");
    await click("Add Target", ui.host);
    await fill(inputByLabel(ui.host, "Host"), "new-backend");
    await click("Add Target", ui.host);
    expect(writes).toHaveLength(0);
    await click("Create Upstream", ui.host);
    await settle(() => expect(router.state.location.pathname).toBe("/upstreams/orders"));
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Created upstream"));
    expect(writes).toHaveLength(1);
    const payload: UpstreamCreate = {
      name: "Created upstream", algorithm: "round_robin", backend_tls_verify_server_cert: true,
      targets: [{ host: "new-backend", port: 80, weight: 1, path: null, locality: null, tags: {} }],
    };
    expect(await writes[0].json()).toEqual(payload);
    expect(writes[0].method).toBe("POST");
  });

  it("adds, edits and removes targets while preserving the upstream's other writable settings", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "second-backend");
    await click("Add Target", panel());
    await settle(() => expect(panel().textContent).toContain("second-backend:80"));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(current?.targets).toHaveLength(2);
    await act(async () => rowActions()[0].click());
    await fill(inputByLabel(panel(), "Host"), "edited-backend");
    await fill(inputByLabel(panel(), "Weight"), "5");
    await click("Update Target", panel());
    await settle(() => expect(panel().textContent).toContain("edited-backend:8080"));
    expect(panel().textContent).toContain("version:v1");
    expect(panel().textContent).toContain("/v1");
    await act(async () => rowActions()[3].click());
    await settle(() => expect(current?.targets).toHaveLength(1));
    await settle(() => expect(panel().textContent).not.toContain("second-backend:80"));
    expect(writes).toHaveLength(3);
    for (const request of writes) {
      const payload = await request.json();
      expect(payload).toMatchObject({ id: "orders", backend_tls_sni: "orders.internal", labels: { owner: "payments" } });
      expect(payload).not.toHaveProperty("namespace");
      expect(payload).not.toHaveProperty("created_at");
      expect(payload).not.toHaveProperty("updated_at");
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
      expect(request.method).toBe("PUT");
    }
  });

  it("saves configuration and retires the detail cache after confirmed deletion", async () => {
    const router = await mount();
    await settle(() => expect(panel().textContent).toContain("Update Upstream"));
    await fill(inputByLabel(panel(), "Name"), "Renamed upstream");
    await click("Update Upstream", panel());
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("Renamed upstream"));
    expect(await writes[0].json()).toMatchObject({ name: "Renamed upstream", targets: initial.targets });
    await click("Delete", ui.host);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Renamed upstream");
    expect(writes).toHaveLength(1);
    await click("Delete Upstream");
    await settle(() => expect(router.state.location.pathname).toBe("/upstreams"));
    await settle(() => expect(ui.host.textContent).toContain("No upstreams yet"));
    expect(ui.client.getQueryData(["upstream", "tenant-a", "orders"])).toBeUndefined();
    expect(writes[1].method).toBe("DELETE");
  });

  it("surfaces rejected configuration, target and delete writes without losing the resource", async () => {
    failure = true;
    await mount();
    await settle(() => expect(panel().textContent).toContain("Update Upstream"));
    await fill(inputByLabel(panel(), "Name"), "Unsaved name");
    await click("Update Upstream", panel());
    await settle(() => expect(document.body.textContent).toContain("target policy rejected"));
    expect(inputByLabel(panel(), "Name").value).toBe("Unsaved name");
    await selectTab("Targets (1)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "rejected-backend");
    await click("Add Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    // A rejected target save keeps its draft, as the configuration form does.
    expect(inputByLabel(panel(), "Host").value).toBe("rejected-backend");
    expect(panel().textContent).toContain("old-backend:8080");
    await click("Delete", ui.host);
    await click("Delete Upstream");
    await settle(() => expect(writes).toHaveLength(3));
    await settle(() => expect(button("Delete Upstream").disabled).toBe(false));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(current).toEqual(initial);
  });

  it("keeps editing the same target when a row above it is removed", async () => {
    current = {
      ...initial,
      targets: [
        { host: "a-backend", port: 8080, weight: 1 },
        { host: "b-backend", port: 8080, weight: 1 },
        { host: "c-backend", port: 8080, weight: 1 },
      ],
    };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    // Row actions are [edit, remove] per row; open the editor on the third row.
    await act(async () => rowActions()[4].click());
    await fill(inputByLabel(panel(), "Host"), "c-backend-draft");
    // Remove the first row while the third is being edited.
    await act(async () => rowActions()[1].click());
    await settle(() => expect(current?.targets.map((target) => target.host)).toEqual(["b-backend", "c-backend"]));
    await settle(() => expect(panel().textContent).toContain("b-backend:8080"));
    expect(inputByLabel(panel(), "Host").value).toBe("c-backend-draft");
  });

  it("keeps an unsaved configuration draft across a tab switch", async () => {
    await mount();
    await settle(() => expect(panel().textContent).toContain("Update Upstream"));
    await fill(inputByLabel(panel(), "Name"), "Draft name");
    await selectTab("Targets (1)");
    await selectTab("Configuration");
    expect(inputByLabel(panel(), "Name").value).toBe("Draft name");
    expect(writes).toHaveLength(0);
  });

  it("keeps a target draft when a concurrent edit refuses the save", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "my-backend");
    // Another administrator replaces the targets after this page loaded.
    current = { ...initial, targets: [{ host: "their-backend", port: 9090, weight: 1 }], updated_at: "2026-09-02T00:00:00Z" };
    await click("Add Target", panel());
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(writes).toHaveLength(0);
    expect(inputByLabel(panel(), "Host").value).toBe("my-backend");
  });

  it("refuses a target edit when a background refetch brought a concurrent change to that target (#445)", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await act(async () => rowActions()[0].click());
    await fill(inputByLabel(panel(), "Path"), "/v2");
    // Another operator changes the same target's weight, and this page's
    // upstream query refetches successfully while the draft is open.
    current = {
      ...initial,
      targets: [{ ...initial.targets[0], weight: 50 }],
      updated_at: "2026-09-02T00:00:00Z",
    };
    const cached = () => ui.client.getQueryData<Upstream>(["upstream", "tenant-a", "orders"]);
    await act(async () => {
      await ui.client.refetchQueries({ queryKey: ["upstream", "tenant-a", "orders"], exact: true });
    });
    await settle(() => expect(cached()?.targets[0].weight).toBe(50));
    // The open form keeps its draft, seeded before the concurrent change.
    expect(inputByLabel(panel(), "Weight").value).toBe("1");
    expect(inputByLabel(panel(), "Path").value).toBe("/v2");

    await click("Update Target", panel());
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    // Judged against the list the draft was edited from: nothing is sent, and
    // the other operator's weight survives.
    expect(writes).toHaveLength(0);
    expect(current?.targets).toEqual([{ ...initial.targets[0], weight: 50 }]);
    expect(inputByLabel(panel(), "Path").value).toBe("/v2");
    expect(inputByLabel(panel(), "Weight").value).toBe("1");

    // Discarding drops only the target draft and shows the current target.
    await click("Discard my draft and reload");
    await settle(() => expect(panel().textContent).toContain("weight 50"));
    expect(panel().querySelector("input")).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("refuses an add when a background refetch brought a concurrent target change", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "my-backend");
    current = { ...initial, targets: [{ host: "their-backend", port: 9090, weight: 1 }] };
    await act(async () => {
      await ui.client.refetchQueries({ queryKey: ["upstream", "tenant-a", "orders"], exact: true });
    });
    await settle(() => expect(panel().textContent).toContain("their-backend:9090"));
    await click("Add Target", panel());
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(writes).toHaveLength(0);
    expect(inputByLabel(panel(), "Host").value).toBe("my-backend");
  });

  it("still composes a target edit with an unrelated settings change picked up by a refetch", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await act(async () => rowActions()[0].click());
    await fill(inputByLabel(panel(), "Path"), "/v2");
    current = { ...initial, backend_tls_sni: "orders.example", updated_at: "2026-09-02T00:00:00Z" };
    const tag = etagOf(current);
    await act(async () => {
      await ui.client.refetchQueries({ queryKey: ["upstream", "tenant-a", "orders"], exact: true });
    });
    await click("Update Target", panel());
    await settle(() => expect(panel().textContent).toContain("/v2"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0].headers.get("If-Match")).toBe(tag);
    expect(await writes[0].json()).toMatchObject({
      backend_tls_sni: "orders.example",
      targets: [{ ...initial.targets[0], path: "/v2" }],
    });
  });

  it("offers a route back when the requested upstream no longer exists", async () => {
    current = undefined;
    const router = await mount();
    await settle(() => expect(ui.host.textContent).toContain("Failed to load upstream configuration"));
    await click("Back to Upstreams", ui.host);
    await settle(() => expect(router.state.location.pathname).toBe("/upstreams"));
  });
});
