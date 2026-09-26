/* ------------------------------------------------------------------ */
/*  A restore retires the restored namespace's detail caches (#446),   */
/*  so a seed-once editor opened afterwards shows the restored         */
/*  resource instead of the invalidated pre-restore entry. Lists an    */
/*  editor seeds from (plugin proxy-group membership) are retired too. */
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
import type { PluginConfig, Proxy, Upstream } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import { createHarness, page, panel, settle, stubFetch } from "@/test/__tests__/harness";
import PluginDetailPage from "@/routes/plugins/$pluginId";
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

const plugin: PluginConfig = {
  id: "group-1", plugin_name: "rate_limiting", scope: "proxy_group", config: {}, enabled: true,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

/** A proxy that names `plugin` among its plugins, so it is a group member. */
function member(id: string): Proxy {
  return {
    id, listen_path: `/${id}`, backend_scheme: "http", backend_host: "localhost", backend_port: 8080,
    hosts: [], strip_listen_path: false, preserve_host_header: false,
    backend_connect_timeout_ms: 5000, backend_read_timeout_ms: 5000, backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true, auth_mode: "single", frontend_tls: false, passthrough: false,
    udp_idle_timeout_seconds: 60, allowed_ws_origins: [], response_body_mode: "stream",
    plugins: [{ plugin_config_id: plugin.id }],
    created_at: plugin.created_at, updated_at: plugin.updated_at,
  };
}

let ui: ReturnType<typeof createHarness>;
let current: Upstream;
let members: Proxy[];
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
  // A server failure that does not say what it left behind proves nothing.
  ["server failure without a rollback outcome", () => Response.json({ error: "restore failed" }, { status: 500 })],
  ["unparseable server failure", () => new Response("internal error", { status: 503 })],
];

/** Failures whose answer proves the namespace was not changed. */
const unchanged: [string, () => Response][] = [
  ["rejected document", () => Response.json({ error: "invalid backup document" }, { status: 400 })],
  ["completed rollback", () => Response.json({
    error: "restore import failed", rollback: "completed", restore_errors: ["upstream import failed"],
  }, { status: 500 })],
  ["rollback not needed", () => Response.json({ error: "restore import failed", rollback: "not_needed" }, { status: 500 })],
  ["pre-commit connectivity failure", () => Response.json({
    error: "database unreachable", failure_class: "connectivity", restore_errors: ["snapshot failed"],
  }, { status: 503 })],
  ["upload-phase timeout", () => Response.json({
    error: "upload timed out", code: "FERRUM_BFF_TIMEOUT", phase: "upload",
  }, { status: 504 })],
];

beforeEach(() => {
  ui = createHarness();
  current = before;
  members = [member("source")];
  restores = [];
  clearGatewayMetadata();
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/proxy/restore") {
      restores.push(request);
      // The stub replaces the upstream whatever it answers; what the client
      // may conclude from each answer is what these tests pin.
      current = after;
      members = [member("destination")];
      return restoreAnswer();
    }
    if (request.method !== "GET") throw new Error(`Unexpected write: ${request.method} ${path}`);
    if (path === "/api/proxy/upstreams/orders") return Response.json(current);
    if (path === "/api/proxy/plugins") return Response.json(["rate_limiting"]);
    if (path === "/api/proxy/plugins/config/group-1") return Response.json(plugin);
    if (path === "/api/proxy/proxies") return Response.json(page(members));
    return Response.json(page([]));
  });
});

afterEach(async () => {
  await ui.dispose();
  clearGatewayMetadata();
  vi.unstubAllGlobals();
});

async function mount(initialPath = "/upstreams/orders") {
  const parent = createRootRoute();
  const detail = createRoute({
    getParentRoute: () => parent, path: "/upstreams/$upstreamId", component: UpstreamDetailPage,
  });
  const pluginDetail = createRoute({
    getParentRoute: () => parent, path: "/plugins/$pluginId", component: PluginDetailPage,
  });
  const settings = createRoute({ getParentRoute: () => parent, path: "/settings", component: RestoreProbe });
  const router = createRouter({
    routeTree: parent.addChildren([detail, pluginDetail, settings]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
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

  it.each(unchanged)("keeps the cached detail after a %s", async (_label, answer) => {
    restoreAnswer = answer;
    const router = await mount();
    await settle(() => expect(inputByLabel(panel(), "Name").value).toBe("Before restore"));
    await act(async () => { await router.navigate({ to: "/settings" }); });
    await settle(() => expect(ui.host.textContent).toContain("restore page"));

    await act(async () => { await restore("tenant-a").catch(() => undefined); });
    expect(restores).toHaveLength(1);
    expect(ui.client.getQueryData<Upstream>(DETAIL)?.name).toBe("Before restore");
  });

  it("seeds a reopened plugin's proxy-group membership from the restored proxy list", async () => {
    restoreAnswer = outcomes[0][1];
    const memberships = () => [...ui.host.querySelectorAll("button[aria-label^='Remove /']")]
      .map((entry) => entry.getAttribute("aria-label"));
    const router = await mount("/plugins/group-1");
    await settle(() => expect(memberships()).toEqual(["Remove /source"]));

    // Leave the plugin so its detail and the proxy list are cached but inactive.
    await act(async () => { await router.navigate({ to: "/settings" }); });
    await settle(() => expect(ui.host.textContent).toContain("restore page"));
    ui.client.setQueryData(["proxies", "tenant-b", "all"], [member("other-tenant")]);

    await act(async () => { await restore("tenant-a"); });
    expect(ui.client.getQueryState(["proxies", "tenant-a", "all"])).toBeUndefined();
    expect(ui.client.getQueryData(["proxies", "tenant-b", "all"])).toEqual([member("other-tenant")]);

    await act(async () => {
      await router.navigate({ to: "/plugins/$pluginId", params: { pluginId: "group-1" } });
    });
    await settle(() => expect(memberships()).toEqual(["Remove /destination"]));
  });
});
