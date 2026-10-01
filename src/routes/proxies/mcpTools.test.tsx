/* ------------------------------------------------------------------ */
/*  The proxy page's MCP Tools tab (issue #505): the node's cached     */
/*  tool catalog, inline per-tool policy edits through the             */
/*  conditional-write path, and the AI governance summary.             */
/* ------------------------------------------------------------------ */

import { act } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalogResponse, McpToolCatalogTool } from "@/api/mcpTools";
import type { PluginConfig } from "@/api/types";
import type { GatewayRole } from "@/lib/capabilities";
import { CapabilityProvider } from "@/stores/capabilities";
import {
  button,
  createHarness,
  fill,
  page,
  panel,
  selectOption,
  selectTab,
  settle,
  stubFetch,
} from "@/test/__tests__/harness";
import { detailedHealth } from "@/test/__tests__/healthFixtures";
import ProxyDetailPage from "./$proxyId";

let namespace: string;
let role: GatewayRole;
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: namespace, scope: { namespace } }),
}));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: { role } }) }));

const proxy = {
  id: "agents", name: "Agent tools", listen_path: "/agents", backend_scheme: "https",
  backend_host: "agents.internal", backend_port: 8443, hosts: [], strip_listen_path: true,
  preserve_host_header: false, backend_connect_timeout_ms: 5000,
  backend_read_timeout_ms: 5000, backend_write_timeout_ms: 5000,
  backend_tls_verify_server_cert: true, auth_mode: "single", frontend_tls: false,
  passthrough: false, udp_idle_timeout_seconds: 60, allowed_ws_origins: [],
  response_body_mode: "stream", plugins: [{ plugin_config_id: "mcp" }, { plugin_config_id: "limits" }],
  created_at: "2026-09-19T12:00:00Z", updated_at: "2026-09-19T12:00:00Z",
};

function mcpPlugin(upstreamUrl = "https://mcp.example.com/mcp"): PluginConfig {
  return {
    id: "mcp", namespace: "tenant-a", plugin_name: "mcp_gateway",
    labels: { "provisioned-by": "ferrum-nexus" },
    config: {
      mode: "aggregate_router",
      endpoint: { path: "/mcp" },
      servers: {
        github: { upstream_url: upstreamUrl, namespace: "github" },
        orders: { namespace: "orders", openapi: { operations: [] } },
      },
      policy: {
        default_action: "deny",
        tools: {
          "github.search": { action: "allow" },
          "orders.cancel": { action: "deny" },
          "github.archived": { action: "hide_from_discovery" },
        },
      },
    },
    scope: "proxy", proxy_id: "agents", enabled: true, priority_override: null,
    trigger: null, api_spec_id: null,
    created_at: "2026-09-19T12:00:00Z", updated_at: "2026-09-19T12:00:00Z",
  };
}

const toolCallLimit: PluginConfig = {
  id: "limits", namespace: "tenant-a", plugin_name: "rate_limiting",
  config: { limit_by: "consumer", limits: [{ scope: "default", requests_per_minute: 60 }], mcp_tool_calls: { endpoint_path: "/mcp" } },
  scope: "proxy", proxy_id: "agents", enabled: true,
  created_at: "2026-09-19T12:00:00Z", updated_at: "2026-09-19T12:00:00Z",
};

function tool(name: string, overrides: Partial<McpToolCatalogTool>): McpToolCatalogTool {
  return {
    name, plugin_config_id: "mcp", title: null, description: null, annotations: null,
    source: { type: "upstream", server_id: "github", namespace: "github", upstream_name: name.split(".")[1] },
    policy: { action: "allow", configured: true, effective: "allow", listed: true, callable: true },
    allowed_groups: null, denied_groups: [], schema_hash: "a".repeat(64),
    discovered_at: "2026-09-30T12:00:00Z",
    ...overrides,
  };
}

function servedCatalog(): McpToolCatalogResponse {
  const data = [
    tool("github.search", {
      title: "Search issues", description: "Search issues across the organization.",
      annotations: { readOnlyHint: true },
    }),
    tool("orders.cancel", {
      description: "Cancel one order.",
      annotations: { destructiveHint: true },
      source: {
        type: "openapi", server_id: "orders", namespace: "orders",
        operation_name: "cancel", method: "DELETE", path: "/agents/orders/{id}",
      },
      policy: { action: "deny", configured: true, effective: "deny", listed: false, callable: false },
    }),
  ];
  return {
    proxy_id: "agents", namespace: "tenant-a", refreshed_at: "2026-09-30T12:00:00Z", stale: false,
    catalogs: [{
      plugin_config_id: "mcp", catalog_state: "fresh", mode: "aggregate_router", enabled: true,
      endpoint_path: "/mcp", refreshed_at: "2026-09-30T12:00:00Z", stale: false,
      cache_ttl_seconds: 300, catalog_version: 3, cached_sessions: 2, tool_count: 2,
      tools_unavailable: false,
      discovery: { on_new_tool: "hide_until_configured", on_schema_change: "hide_until_configured" },
      policy: { default_action: "deny", hide_denied_tools: true },
      limits: { max_catalog_items_per_list: 1000, max_catalog_bytes_per_list: 1048576 },
      servers: [
        {
          server_id: "github", namespace: "github", kind: "mcp",
          upstream_url: "https://mcp.example.com/[REDACTED_PATH]", enabled: true,
          expose_tools: true, tools_refresh: "stale",
          refresh_error: "the most recent tools/list refresh failed; last-good tools are served",
        },
        {
          server_id: "orders", namespace: "orders", kind: "openapi", upstream_url: null,
          enabled: true, expose_tools: true, tools_refresh: "ok", refresh_error: null,
        },
      ],
    }],
    data,
    pagination: { offset: 0, limit: 1000, total: data.length },
  };
}

function notServedCatalog(): McpToolCatalogResponse {
  return {
    proxy_id: "agents", namespace: "tenant-a", refreshed_at: null, stale: true,
    catalogs: [{
      plugin_config_id: "mcp", catalog_state: "not_served", refreshed_at: null, stale: true,
      tool_count: 0, servers: [],
    }],
    data: [],
    pagination: { offset: 0, limit: 1000, total: 0 },
  };
}

let harness: ReturnType<typeof createHarness>;
let requests: Request[];
let puts: { body: Record<string, unknown>; ifMatch: string | null }[];
let gatewayMode: string;
let catalog: McpToolCatalogResponse | "none";
let stored: PluginConfig;
let pluginList: PluginConfig[];
let revision: number;

beforeEach(() => {
  namespace = "tenant-a";
  role = "admin";
  requests = [];
  puts = [];
  gatewayMode = "database";
  catalog = servedCatalog();
  stored = mcpPlugin();
  pluginList = [stored, toolCallLimit];
  revision = 1;
  // Radix Select scrolls the highlighted option into view; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  harness = createHarness();
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    if (path === "health") return Response.json({ ...detailedHealth, mode: gatewayMode });
    if (path === "proxies/agents") return Response.json(proxy);
    if (path === "proxies/agents/mcp/tools") {
      return catalog === "none"
        ? Response.json({ error: "Proxy has no mcp_gateway plugin" }, { status: 404 })
        : Response.json(catalog);
    }
    if (path === "plugins/config/mcp") {
      if (request.method === "PUT") {
        const body = await request.json() as Record<string, unknown>;
        puts.push({ body, ifMatch: request.headers.get("If-Match") });
        revision += 1;
        stored = { ...stored, ...(body as Partial<PluginConfig>), updated_at: `rev-${revision}` };
      }
      return Response.json(stored, { headers: { etag: `"rev-${revision}"` } });
    }
    if (path === "plugins/config") return Response.json(page(pluginList));
    return Response.json(page([]));
  });
});

afterEach(async () => {
  await harness.dispose();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function openTools() {
  const parent = createRootRoute();
  const proxyRoute = createRoute({
    getParentRoute: () => parent, path: "/proxies/$proxyId", component: ProxyDetailPage,
  });
  const pluginRoute = createRoute({
    getParentRoute: () => parent, path: "/plugins/$pluginId", component: () => null,
  });
  const newPluginRoute = createRoute({
    getParentRoute: () => parent, path: "/plugins/new", component: () => null,
  });
  const router = createRouter({
    routeTree: parent.addChildren([proxyRoute, pluginRoute, newPluginRoute]),
    history: createMemoryHistory({ initialEntries: ["/proxies/agents"] }),
  });
  await act(async () => { await router.load(); });
  await harness.render(<CapabilityProvider><RouterProvider router={router} /></CapabilityProvider>);
  await settle(() => expect(harness.host.textContent).toContain("Agent tools"));
  // Nothing about MCP is read until the tab is asked for.
  expect(requests.some((request) => request.url.includes("/mcp/tools"))).toBe(false);
  await selectTab("MCP Tools");
}

function toolRow(name: string): HTMLElement {
  const row = panel().querySelector<HTMLElement>(`[data-tool="${name}"]`);
  expect(row, `row ${name}`).not.toBeNull();
  return row!;
}

describe("MCP Tools tab", () => {
  it("shows every tool with its source, annotations, policy, and grants", async () => {
    await openTools();
    await settle(() => expect(panel().textContent).toContain("github.search"));
    const text = panel().textContent ?? "";
    expect(text).toContain("2 tools cached on this gateway node");
    expect(text).toContain("Fresh");
    expect(text).toContain("Search issues across the organization.");
    expect(text).toContain("Upstream MCP server github");
    expect(text).toContain("Generated from OpenAPI operation");
    expect(text).toContain("DELETE /agents/orders/{id}");
    // A refresh failure is shown as Edge's fixed text, never an upstream body.
    expect(text).toContain("the most recent tools/list refresh failed; last-good tools are served");
    expect(text).toContain("https://mcp.example.com/[REDACTED_PATH]");
    expect(text).toContain("Provisioned by Ferrum Nexus");

    const search = toolRow("github.search");
    expect(search.textContent).toContain("Read-only");
    expect(search.textContent).toContain("Configured: Allow");
    expect(search.textContent).toContain("Allowed");
    expect(search.textContent).toContain("Every consumer the action allows");
    const cancel = toolRow("orders.cancel");
    expect(cancel.textContent).toContain("Destructive");
    expect(cancel.textContent).toContain("Configured: Deny");
    expect(cancel.textContent).toContain("Not listed");
    // Named in policy.tools but not discovered on this node.
    expect(toolRow("github.archived").textContent).toContain("not in this node's catalog");

    expect(requests.filter((request) => request.url.includes("/mcp/tools"))
      .every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
  });

  it("writes a per-tool grant through If-Match and keeps the provisioner's labels", async () => {
    await openTools();
    await settle(() => expect(panel().textContent).toContain("github.search"));
    await act(async () => button("Edit policy for github.search").click());

    const groups = [...panel().querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent === "Allowed groups")!;
    const input = document.getElementById(groups.htmlFor) as HTMLInputElement;
    await fill(input, "eng");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => button("Save policy").click());

    await settle(() => expect(puts).toHaveLength(1));
    expect(puts[0].ifMatch).toBe('"rev-1"');
    expect(puts[0].body).not.toHaveProperty("labels");
    expect((puts[0].body.config as { policy: unknown }).policy).toEqual({
      default_action: "deny",
      tools: {
        "github.search": { action: "allow", allowed_groups: ["eng"] },
        "orders.cancel": { action: "deny" },
        "github.archived": { action: "hide_from_discovery" },
      },
    });
    // The node still enforces the old policy until it reloads: the row says so.
    await settle(() => expect(toolRow("github.search").textContent).toContain("Saved, not yet live on this node"));
    expect(toolRow("github.search").textContent).toContain("eng");
  });

  it("changes an action and refuses a grant Edge would refuse, before sending", async () => {
    await openTools();
    await settle(() => expect(panel().textContent).toContain("orders.cancel"));
    await act(async () => button("Edit policy for orders.cancel").click());
    await selectOption("Action", "Hide from discovery");
    await act(async () => button("Save policy").click());
    await settle(() => expect(puts).toHaveLength(1));
    expect((puts[0].body.config as { policy: { tools: Record<string, unknown> } }).policy.tools["orders.cancel"])
      .toEqual({ action: "hide_from_discovery" });

    await settle(() => expect(button("Edit policy for github.search").disabled).toBe(false));
    await act(async () => button("Edit policy for github.search").click());
    const denied = [...panel().querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent === "Denied groups")!;
    const allowed = [...panel().querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent === "Allowed groups")!;
    for (const label of [allowed, denied]) {
      const input = document.getElementById(label.htmlFor) as HTMLInputElement;
      await fill(input, "ops");
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    }
    await act(async () => button("Save policy").click());
    await settle(() => expect(panel().textContent).toContain("both allowed and denied: ops"));
    expect(puts).toHaveLength(1);
  });

  it("shows the catalog read-only to a viewer", async () => {
    role = "viewer";
    await openTools();
    await settle(() => expect(panel().textContent).toContain("github.search"));
    expect(panel().textContent).toContain("Plugin configuration is read-only");
    expect(button("Edit policy for github.search").disabled).toBe(true);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("blocks an operator whose read masks a value the save would resend", async () => {
    role = "operator";
    stored = mcpPlugin("https://mcp.example.com/[REDACTED_PATH]");
    pluginList = [stored, toolCallLimit];
    await openTools();
    await settle(() =>
      expect(panel().textContent).toContain("Tool policy cannot be saved by your role"));
    expect(panel().textContent).toContain("/config/servers/github/upstream_url");
    // A server URL is required and not a secret: it cannot be cleared.
    expect(panel().textContent).toContain("Re-enter the URL on the plugin page first");
    expect(panel().textContent).not.toContain("clearing deletes the stored secret");
    expect(button("Edit policy for github.search").disabled).toBe(true);
  });

  it("explains a control plane's node-local not_served catalog and keeps the stored policy editable", async () => {
    gatewayMode = "cp";
    catalog = notServedCatalog();
    await openTools();
    await settle(() => expect(panel().textContent).toContain("Foundry is connected to a control plane"));
    expect(panel().textContent).toContain("Not served here");
    expect(toolRow("github.search").textContent).toContain("not in this node's catalog");
    expect(toolRow("github.search").textContent).toContain("Configured: Allow");
    expect(button("Edit policy for github.search").disabled).toBe(false);
  });

  it("says when no mcp_gateway applies to the proxy", async () => {
    catalog = "none";
    pluginList = [toolCallLimit];
    await openTools();
    await settle(() =>
      expect(panel().textContent).toContain("reports no enabled mcp_gateway plugin for this proxy"));
    await settle(() => expect(requests.some((request) =>
      new URL(request.url).pathname === "/api/proxy/plugins/config")).toBe(true));
    expect(panel().textContent).toContain("reports no enabled mcp_gateway plugin");
    expect(panel().textContent).not.toContain("AI governance");
  });

  it("does not deny an mcp_gateway the stored configuration attaches but the node has not loaded", async () => {
    catalog = "none";
    await openTools();
    await settle(() =>
      expect(panel().textContent).toContain("This gateway node has not loaded the proxy's mcp_gateway"));
    expect(panel().textContent).toContain("namespace this node has not cached");
    expect(panel().textContent).not.toContain("reports no enabled mcp_gateway");
  });

  it("says that removing an entry leaves the tool hidden until configured", async () => {
    await openTools();
    await settle(() => expect(panel().textContent).toContain("orders.cancel"));
    await act(async () => button("Edit policy for orders.cancel").click());
    expect(panel().textContent).toContain(
      "hidden from new sessions until configured; sessions that already list it fall back " +
        "to the default (Deny)",
    );
    await selectOption("Action", "Remove entry (hidden until configured)");
    await act(async () => button("Save policy").click());
    await settle(() => expect(puts).toHaveLength(1));
    const tools = (puts[0].body.config as { policy: { tools: Record<string, unknown> } }).policy.tools;
    expect(tools).not.toHaveProperty(["orders.cancel"]);
    await settle(() => expect(toolRow("orders.cancel").textContent)
      .toContain("Configured: No entry (hidden until configured)"));
  });

  it("summarizes AI governance and warns when an agent-facing endpoint has none", async () => {
    await openTools();
    const governance = () => panel().querySelector<HTMLElement>('[aria-label="AI governance"]');
    await settle(() => expect(governance()).not.toBeNull());
    const limit = governance()!.querySelector('[data-governance="tool_call_limit"]');
    expect(limit?.textContent).toContain("Attached");
    expect(limit?.textContent).toContain("limits");
    expect(governance()!.querySelector('[data-governance="ai_tool_governor"]')?.textContent)
      .toContain("Not attached");
    expect(governance()!.textContent).not.toContain("has no AI governance");
    await harness.dispose();

    harness = createHarness();
    pluginList = [stored];
    requests = [];
    await openTools();
    await settle(() => expect(governance()?.textContent).toContain("has no AI governance"));
  });
});
