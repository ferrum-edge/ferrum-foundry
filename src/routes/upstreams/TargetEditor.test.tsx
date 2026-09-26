import { act } from "react";
import { clearGatewayMetadata } from "@/api/gatewayMetadata";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream, UpstreamCreate, UpstreamTarget } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { button, click, createHarness, fill, page, panel, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import UpstreamDetailPage from "./$upstreamId";
import UpstreamNewPage from "./new";
import UpstreamsPage from "./index";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));
let ui: ReturnType<typeof createHarness>;
let current: Upstream | undefined;
let failure: boolean;
// Commit the write but answer committed-but-not-live (`503`, `applied: false`).
let commitNotLive: boolean;
// Runs after a write commits, before the answer: another writer in the gap.
let afterCommit: (() => void) | undefined;
// While set, a write is held unanswered until it resolves.
let hold: Promise<void> | undefined;
// Reads leave out a target's empty optional members (`null`, `{}`).
let omitEmptyOnRead: boolean;
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

/** The upstream as a read returns it. */
function readShape(upstream: Upstream): Upstream {
  if (!omitEmptyOnRead) return upstream;
  return {
    ...upstream,
    targets: upstream.targets.map((entry) => Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== null
        && !(typeof value === "object" && Object.keys(value).length === 0)),
    ) as UpstreamTarget),
  };
}

beforeEach(() => {
  ui = createHarness();
  current = initial;
  failure = false;
  commitNotLive = false;
  afterCommit = undefined;
  hold = undefined;
  omitEmptyOnRead = false;
  writes = [];
  clearGatewayMetadata();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (path === "/api/proxy/upstreams") return Response.json(page(current ? [current] : []));
      if (path === "/api/proxy/upstreams/orders") return current
        ? Response.json(readShape(current), { headers: { ETag: etagOf(current) } })
        : Response.json({ error: "upstream missing" }, { status: 404 });
      throw new Error(`Unexpected upstream read: ${path}`);
    }
    writes.push(request);
    if (hold) await hold;
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
    const accepted = current;
    afterCommit?.();
    if (commitNotLive) return Response.json({ applied: false }, { status: 503 });
    return Response.json(accepted);
  });
});
afterEach(async () => {
  await ui.dispose();
  clearGatewayMetadata();
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

const cachedUpstream = () => ui.client.getQueryData<Upstream>(["upstream", "tenant-a", "orders"]);

async function refetchUpstream() {
  await act(async () => {
    await ui.client.refetchQueries({ queryKey: ["upstream", "tenant-a", "orders"], exact: true });
  });
}

const target = (host: string) => ({ host, port: 8080, weight: 1 });

/** How many target forms are open: each has one Host field. */
const openTargetForms = () => [...panel().querySelectorAll("label")]
  .filter((label) => label.textContent?.trim() === "Host").length;

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

  it("keeps editing the same target when a row above it is removed (#448)", async () => {
    current = { ...initial, targets: [target("a-backend"), target("b-backend"), target("c-backend")] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Edit target c-backend:8080", panel());
    await fill(inputByLabel(panel(), "Host"), "c-backend-draft");
    // Remove the first row while the third is being edited.
    await click("Remove target a-backend:8080", panel());
    await settle(() => expect(current?.targets.map((entry) => entry.host)).toEqual(["b-backend", "c-backend"]));
    await settle(() => expect(panel().textContent).toContain("b-backend:8080"));
    expect(inputByLabel(panel(), "Host").value).toBe("c-backend-draft");
    // The removal was computed from the list the form was opened on, so the
    // form's basis moved with it and the edit saves onto the shorter list.
    await click("Update Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(current?.targets.map((entry) => entry.host)).toEqual(["b-backend", "c-backend-draft"]);
  });

  it("keeps the edit form on its own target when a refetch shifts the rows", async () => {
    const [a, b, c, x] = ["a-backend", "b-backend", "c-backend", "x-backend"].map(target);
    current = { ...initial, targets: [a, b, c] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Edit target c-backend:8080", panel());
    await fill(inputByLabel(panel(), "Host"), "c-backend-draft");

    // Another operator inserts a target ahead of the edited one.
    current = { ...initial, targets: [x, a, b, c] };
    await refetchUpstream();
    await settle(() => expect(panel().textContent).toContain("x-backend:8080"));
    expect(inputByLabel(panel(), "Host").value).toBe("c-backend-draft");
    expect(panel().querySelectorAll("input[type=number]")).toHaveLength(2);

    // Removing that row returns the gateway to the list the draft was edited
    // against; the form stays on its target and keeps its typing.
    await click("Remove target x-backend:8080", panel());
    await settle(() => expect(current?.targets).toEqual([a, b, c]));
    await settle(() => expect(panel().textContent).not.toContain("x-backend:8080"));
    expect(inputByLabel(panel(), "Host").value).toBe("c-backend-draft");

    // Update Target saves — it never returns without a word.
    await click("Update Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(current?.targets).toEqual([a, b, { ...c, host: "c-backend-draft", path: null, locality: null, tags: {} }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("adopts a committed-but-not-live removal as an open form's basis when the read holds exactly that list", async () => {
    const [a, b, c] = ["a-backend", "b-backend", "c-backend"].map(target);
    current = { ...initial, targets: [a, b, c] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "d-backend");
    commitNotLive = true;
    await click("Remove target a-backend:8080", panel());
    // Reported once the page has read back what the removal committed.
    await settle(() => expect(document.body.textContent).toContain("Targets saved"));
    await settle(() => expect(cachedUpstream()?.targets).toEqual([b, c]));
    await settle(() => expect(panel().textContent).not.toContain("a-backend:8080"));
    expect(inputByLabel(panel(), "Host").value).toBe("d-backend");

    commitNotLive = false;
    await click("Add Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    // Judged against the operator's own committed removal, not refused by it.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(current?.targets.map((entry) => entry.host)).toEqual(["b-backend", "c-backend", "d-backend"]);
  });

  it("adopts a committed-but-not-live removal when the read leaves out empty optional target members (#464)", async () => {
    // Targets as Foundry's own target form writes them.
    const [a, b, c] = ["a-backend", "b-backend", "c-backend"]
      .map((host) => ({ ...target(host), path: null, locality: null, tags: {} }));
    current = { ...initial, targets: [a, b, c] };
    omitEmptyOnRead = true;
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "d-backend");
    commitNotLive = true;
    await click("Remove target a-backend:8080", panel());
    await settle(() => expect(document.body.textContent).toContain("Targets saved"));
    await settle(() => expect(cachedUpstream()?.targets.map((entry) => entry.host)).toEqual(["b-backend", "c-backend"]));
    expect(cachedUpstream()?.targets[0]).not.toHaveProperty("path");

    commitNotLive = false;
    await click("Add Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(current?.targets.map((entry) => entry.host)).toEqual(["b-backend", "c-backend", "d-backend"]);
  });

  it("keeps refusing after a committed-but-not-live removal when the read holds another writer's change too", async () => {
    const [a, b, c, z] = ["a-backend", "b-backend", "c-backend", "z-backend"].map(target);
    current = { ...initial, targets: [a, b, c] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "d-backend");
    commitNotLive = true;
    // Another writer adds a target between this removal's commit and the read.
    afterCommit = () => {
      current = { ...initial, targets: [b, c, z] };
    };
    await click("Remove target a-backend:8080", panel());
    await settle(() => expect(document.body.textContent).toContain("Targets saved"));
    await settle(() => expect(cachedUpstream()?.targets).toEqual([b, c, z]));
    await settle(() => expect(panel().textContent).toContain("z-backend:8080"));

    commitNotLive = false;
    afterCommit = undefined;
    await click("Add Target", panel());
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(writes).toHaveLength(1);
    expect(current?.targets).toEqual([b, c, z]);
    expect(inputByLabel(panel(), "Host").value).toBe("d-backend");
  });

  it("keeps typing in a duplicate-address target's form when an earlier duplicate is removed (#464)", async () => {
    const [first, second, b] = [
      { ...target("a-backend"), weight: 1 },
      { ...target("a-backend"), weight: 2 },
      target("b-backend"),
    ];
    current = { ...initial, targets: [first, second, b] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Edit target a-backend:8080 (2 of 2)", panel());
    await fill(inputByLabel(panel(), "Host"), "a-backend-draft");
    // Removing the earlier duplicate renumbers the edited target's identity
    // (`a-backend:8080#1` becomes `#0`); the form must not remount.
    await click("Remove target a-backend:8080 (1 of 2)", panel());
    await settle(() => expect(current?.targets).toEqual([second, b]));
    await settle(() => expect(panel().textContent).toContain("Targets (2)"));
    expect(inputByLabel(panel(), "Host").value).toBe("a-backend-draft");
    expect(openTargetForms()).toBe(1);
    expect(panel().querySelectorAll("input[type=number]")).toHaveLength(2);
    expect(panel().textContent).not.toContain("no longer in the upstream");

    await click("Update Target", panel());
    await settle(() => expect(writes).toHaveLength(2));
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(current?.targets.map((entry) => [entry.host, entry.weight])).toEqual([
      ["a-backend-draft", 2], ["b-backend", 1],
    ]);
  });

  it("keeps a duplicate-address form on its row when a committed-but-not-live removal is not adopted (#464)", async () => {
    const [first, second, b, z] = [
      { ...target("a-backend"), weight: 1 },
      { ...target("a-backend"), weight: 2 },
      target("b-backend"),
      target("z-backend"),
    ];
    current = { ...initial, targets: [first, second, b] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    await click("Edit target a-backend:8080 (2 of 2)", panel());
    await fill(inputByLabel(panel(), "Host"), "a-backend-draft");
    commitNotLive = true;
    // Another writer adds a target between this removal's commit and the read,
    // so the open form's basis is not moved.
    afterCommit = () => {
      current = { ...initial, targets: [second, b, z] };
    };
    await click("Remove target a-backend:8080 (1 of 2)", panel());
    await settle(() => expect(document.body.textContent).toContain("Targets saved"));
    await settle(() => expect(panel().textContent).toContain("z-backend:8080"));
    // The form stays in place of its own target rather than appearing as a
    // "no longer listed" row beside it.
    expect(inputByLabel(panel(), "Host").value).toBe("a-backend-draft");
    expect(openTargetForms()).toBe(1);
    expect(panel().textContent).not.toContain("no longer in the upstream");
    expect(panel().querySelector('button[aria-label^="Edit target a-backend"]')).toBeNull();

    // Its basis did not move, so the save is still refused, not rebased.
    commitNotLive = false;
    afterCommit = undefined;
    await click("Update Target", panel());
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(writes).toHaveLength(1);
    expect(current?.targets).toEqual([second, b, z]);
  });

  it("says why a target submission sent while another save is pending does nothing (#464)", async () => {
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (1)"));
    await selectTab("Targets (1)");
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "second-backend");
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    await click("Add Target", panel());
    await settle(() => expect(writes).toHaveLength(1));
    // A second submission that raced the disabled controls is refused aloud.
    await act(async () => {
      inputByLabel(panel(), "Host").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle(() => expect(document.body.textContent).toContain("Another save for this upstream is still in progress"));
    expect(writes).toHaveLength(1);
    await act(async () => release());
    await settle(() => expect(panel().querySelector("input")).toBeNull());
    expect(writes).toHaveLength(1);
    expect(current?.targets).toHaveLength(2);
  });

  it("does not let a second target form replace an open draft (#464)", async () => {
    current = { ...initial, targets: [target("a-backend"), target("b-backend")] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (2)"));
    await selectTab("Targets (2)");
    await click("Edit target a-backend:8080", panel());
    await fill(inputByLabel(panel(), "Host"), "a-backend-draft");
    expect(button("Add Target", panel()).disabled).toBe(true);
    expect(button("Edit target b-backend:8080", panel()).disabled).toBe(true);
    expect(panel().textContent).toContain("Save or cancel the open target form first");
    await act(async () => button("Edit target b-backend:8080", panel()).click());
    expect(inputByLabel(panel(), "Host").value).toBe("a-backend-draft");

    await click("Cancel", panel());
    await click("Add Target", panel());
    await fill(inputByLabel(panel(), "Host"), "c-backend");
    expect(button("Edit target a-backend:8080", panel()).disabled).toBe(true);
    expect(button("Edit target b-backend:8080", panel()).disabled).toBe(true);
    expect(inputByLabel(panel(), "Host").value).toBe("c-backend");
    expect(writes).toHaveLength(0);
  });

  it("names each target row action after its target (#455)", async () => {
    current = { ...initial, targets: [target("a-backend"), target("b-backend"), target("b-backend")] };
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Targets (3)"));
    await selectTab("Targets (3)");
    const names = [...panel().querySelectorAll<HTMLButtonElement>("button[aria-label]")]
      .map((entry) => entry.getAttribute("aria-label"));
    expect(names).toEqual([
      "Edit target a-backend:8080", "Remove target a-backend:8080",
      "Edit target b-backend:8080 (1 of 2)", "Remove target b-backend:8080 (1 of 2)",
      "Edit target b-backend:8080 (2 of 2)", "Remove target b-backend:8080 (2 of 2)",
    ]);
    for (const icon of panel().querySelectorAll("button[aria-label] svg")) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    // Every icon-only action is named.
    expect(rowActions().every((entry) => entry.getAttribute("aria-label"))).toBe(true);
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
    await settle(() => expect(panel().textContent).toContain("Update Upstream"));
    // An unsaved settings draft, which a targets refusal must not discard.
    await fill(inputByLabel(panel(), "Name"), "Settings draft");
    await selectTab("Targets (1)");
    await click("Edit target old-backend:8080", panel());
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
    // The settings draft survives.
    await selectTab("Configuration");
    expect(inputByLabel(panel(), "Name").value).toBe("Settings draft");
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
