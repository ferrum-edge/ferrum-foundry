/* ------------------------------------------------------------------ */
/*  A spec write can change which proxies declare a proxy-group        */
/*  plugin. The plugin editor seeds membership once from the cached    */
/*  proxy list, so spec import/replace/delete retire that namespace's  */
/*  inactive lists too (as a restore does), including after a          */
/*  committed-but-not-live answer.                                     */
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
import type { PluginConfig, Proxy } from "@/api/types";
import { createHarness, page, settle, stubFetch } from "@/test/__tests__/harness";
import PluginDetailPage from "@/routes/plugins/$pluginId";
import { useDeleteApiSpec, useUpdateApiSpec } from "./useApiSpecs";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

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

const committedNotLive = () =>
  Response.json({ error: "reload timed out", applied: false, reason: "reload_timeout" }, { status: 503 });

let ui: ReturnType<typeof createHarness>;
let members: Proxy[];
let specAnswer: () => Response;
let specWrite: () => Promise<unknown>;
let mode: "replace" | "delete";

function SpecProbe() {
  const replace = useUpdateApiSpec();
  const remove = useDeleteApiSpec();
  useEffect(() => {
    specWrite = () => mode === "replace"
      ? replace.mutateAsync({ id: "spec-1", document: "openapi: 3.0.0" })
      : remove.mutateAsync("spec-1");
  });
  return <p>spec page</p>;
}

beforeEach(() => {
  ui = createHarness();
  members = [member("source"), member("spec-proxy")];
  clearGatewayMetadata();
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/proxy/api-specs/spec-1" && (request.method === "PUT" || request.method === "DELETE")) {
      // The spec write drops the spec-owned proxy's group association.
      members = [member("source")];
      return specAnswer();
    }
    if (request.method !== "GET") throw new Error(`Unexpected write: ${request.method} ${path}`);
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

async function mount() {
  const parent = createRootRoute();
  const pluginDetail = createRoute({
    getParentRoute: () => parent, path: "/plugins/$pluginId", component: PluginDetailPage,
  });
  const specs = createRoute({ getParentRoute: () => parent, path: "/api-specs", component: SpecProbe });
  const router = createRouter({
    routeTree: parent.addChildren([pluginDetail, specs]),
    history: createMemoryHistory({ initialEntries: ["/plugins/group-1"] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  return router;
}

const memberships = () => [...ui.host.querySelectorAll("button[aria-label^='Remove /']")]
  .map((entry) => entry.getAttribute("aria-label"));

describe("spec write proxy-list retirement", () => {
  it.each([
    ["replace", "success", () => Response.json({ id: "spec-1", proxy_id: "spec-proxy", spec_version: "2", content_hash: "h" })],
    ["replace", "committed-but-not-live", committedNotLive],
    ["delete", "success", () => new Response(null, { status: 204 })],
    ["delete", "committed-but-not-live", committedNotLive],
  ] as const)("reseeds a reopened group's membership after a %s %s answer", async (kind, _label, answer) => {
    mode = kind;
    specAnswer = answer;
    const router = await mount();
    await settle(() => expect(memberships()).toEqual(["Remove /source", "Remove /spec-proxy"]));

    // Leave the plugin so its detail and the proxy list are cached but inactive.
    await act(async () => { await router.navigate({ to: "/api-specs" }); });
    await settle(() => expect(ui.host.textContent).toContain("spec page"));
    ui.client.setQueryData(["proxies", "tenant-b", "all"], [member("other-tenant")]);

    await act(async () => { await specWrite().catch(() => undefined); });
    expect(ui.client.getQueryState(["proxies", "tenant-a", "all"])).toBeUndefined();
    expect(ui.client.getQueryData(["proxies", "tenant-b", "all"])).toEqual([member("other-tenant")]);

    await act(async () => {
      await router.navigate({ to: "/plugins/$pluginId", params: { pluginId: "group-1" } });
    });
    await settle(() => expect(memberships()).toEqual(["Remove /source"]));
  });

  it("keeps the cached proxy list after a definite refusal", async () => {
    mode = "replace";
    specAnswer = () => Response.json({ error: "invalid document" }, { status: 400 });
    const router = await mount();
    await settle(() => expect(memberships()).toEqual(["Remove /source", "Remove /spec-proxy"]));
    await act(async () => { await router.navigate({ to: "/api-specs" }); });
    await settle(() => expect(ui.host.textContent).toContain("spec page"));

    await act(async () => { await specWrite().catch(() => undefined); });
    expect(ui.client.getQueryState(["proxies", "tenant-a", "all"])).toBeDefined();
  });
});
