/* ------------------------------------------------------------------ */
/*  A restore retires the restored namespace's detail caches (#446),   */
/*  so a seed-once editor opened afterwards shows the restored         */
/*  resource instead of the invalidated pre-restore entry.             */
/* ------------------------------------------------------------------ */

import { act, useEffect } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGatewayMetadata } from "@/api/gatewayMetadata";
import type { Upstream } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { createHarness, page, panel, settle, stubFetch } from "@/test/__tests__/harness";
import UpstreamDetailPage from "@/routes/upstreams/$upstreamId";
import { useRestore } from "./useOps";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

const before: Upstream = {
  id: "orders", name: "Before restore", namespace: "tenant-a", algorithm: "round_robin",
  targets: [{ host: "old-backend", port: 8080, weight: 1 }],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const after: Upstream = {
  ...before,
  name: "After restore",
  targets: [{ host: "restored-backend", port: 9090, weight: 1 }],
  updated_at: "2026-09-02T00:00:00Z",
};
const DETAIL = ["upstream", "tenant-a", "orders"];

let ui: ReturnType<typeof createHarness>;
let current: Upstream;
let restoreAnswer: () => Response;
let restores: Request[];
let restore: (namespace: string) => Promise<unknown>;

function RestoreProbe() {
  const mutation = useRestore();
  useEffect(() => {
    restore = (namespace) => mutation.mutateAsync({ data: {}, namespace });
  });
  return <p>restore page</p>;
}

const outcomes: [string, () => Response][] = [
  ["success", () => Response.json({ restored: { proxies: 0, consumers: 0, plugin_configs: 0, upstreams: 1 } })],
  ["committed but not live", () => Response.json({ applied: false }, { status: 503 })],
  ["unobserved", () => Response.json({ error: "upstream connection failed" }, { status: 502 })],
  ["rollback incomplete", () => Response.json({
    error: "restore import failed", rollback: "incomplete", restore_errors: ["upstream import failed"],
  }, { status: 500 })],
];

beforeEach(() => {
  ui = createHarness();
  current = before;
  restores = [];
  clearGatewayMetadata();
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/proxy/restore") {
      restores.push(request);
      // The stub replaces the upstream whatever it answers; what the client
      // may conclude from each answer is what these tests pin.
      current = after;
      return restoreAnswer();
    }
    if (request.method !== "GET") throw new Error(`Unexpected write: ${request.method} ${path}`);
    if (path === "/api/proxy/upstreams/orders") return Response.json(current);
    return Response.json(page([]));
  });
});

afterEach(async () => {
  await ui.dispose();
  clearGatewayMetadata();
  vi.unstubAllGlobals();
});

async function mount() {
  const parent = createRootRoute();
  const detail = createRoute({
    getParentRoute: () => parent, path: "/upstreams/$upstreamId", component: UpstreamDetailPage,
  });
  const settings = createRoute({ getParentRoute: () => parent, path: "/settings", component: RestoreProbe });
  const router = createRouter({
    routeTree: parent.addChildren([detail, settings]),
    history: createMemoryHistory({ initialEntries: ["/upstreams/orders"] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

describe("restore detail-cache retirement", () => {
  it.each(outcomes)("reseeds a reopened editor with the restored upstream after a %s restore", async (_label, answer) => {
    restoreAnswer = answer;
    const router = await mount();
    await settle(() => expect(inputByLabel(panel(), "Name").value).toBe("Before restore"));

    // Leave the upstream so its detail entry is cached but inactive.
    await act(async () => { await router.navigate({ to: "/settings" }); });
    await settle(() => expect(ui.host.textContent).toContain("restore page"));
    expect(ui.client.getQueryData<Upstream>(DETAIL)?.name).toBe("Before restore");
    // Another namespace's entry is not the restore's to retire.
    ui.client.setQueryData(["upstream", "tenant-b", "orders"], { ...before, namespace: "tenant-b" });

    await act(async () => { await restore("tenant-a").catch(() => undefined); });
    expect(restores).toHaveLength(1);
    expect(restores[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    expect(ui.client.getQueryState(DETAIL)).toBeUndefined();
    expect(ui.client.getQueryData<Upstream>(["upstream", "tenant-b", "orders"])?.name).toBe("Before restore");

    await act(async () => {
      await router.navigate({ to: "/upstreams/$upstreamId", params: { upstreamId: "orders" } });
    });
    await settle(() => expect(ui.host.querySelector("h1")?.textContent).toBe("After restore"));
    await settle(() => expect(inputByLabel(panel(), "Name").value).toBe("After restore"));
    expect(ui.client.getQueryData<Upstream>(DETAIL)?.name).toBe("After restore");
  });

  it("keeps the cached detail when the restore provably changed nothing", async () => {
    restoreAnswer = () => Response.json({ error: "invalid backup document" }, { status: 400 });
    const router = await mount();
    await settle(() => expect(inputByLabel(panel(), "Name").value).toBe("Before restore"));
    await act(async () => { await router.navigate({ to: "/settings" }); });
    await settle(() => expect(ui.host.textContent).toContain("restore page"));

    await act(async () => { await restore("tenant-a").catch(() => undefined); });
    expect(restores).toHaveLength(1);
    expect(ui.client.getQueryData<Upstream>(DETAIL)?.name).toBe("Before restore");
  });
});
