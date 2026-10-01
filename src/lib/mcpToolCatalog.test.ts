import { describe, expect, it } from "vitest";
import type { McpToolCatalogTool } from "@/api/mcpTools";
import { catalogStateExplanation, mcpToolRows, policyAwaitingNode } from "./mcpToolCatalog";

function tool(name: string, overrides: Partial<McpToolCatalogTool> = {}): McpToolCatalogTool {
  return {
    name,
    plugin_config_id: "mcp",
    title: null,
    description: null,
    annotations: null,
    source: { type: "upstream", server_id: "github", namespace: "github", upstream_name: name },
    policy: { action: "allow", configured: true, effective: "allow", listed: true, callable: true },
    allowed_groups: null,
    denied_groups: [],
    schema_hash: "a".repeat(64),
    discovered_at: "2026-09-30T12:00:00Z",
    ...overrides,
  };
}

const config = {
  mode: "aggregate_router",
  policy: {
    default_action: "deny",
    tools: {
      "github.search": { action: "allow" },
      "github.legacy": { action: "deny" },
      "github.odd": { action: "sometimes" },
    },
  },
};

describe("tool rows", () => {
  it("lists discovered tools first, then configured tools this node has not discovered", () => {
    const rows = mcpToolRows([tool("github.search"), tool("github.create")], config);
    expect(rows.map((row) => row.name)).toEqual([
      "github.search",
      "github.create",
      "github.legacy",
      "github.odd",
    ]);
    expect(rows[0].configured).toEqual({ action: "allow", allowed_groups: null, denied_groups: null });
    expect(rows[1].configured).toBeNull();
    expect(rows[2].tool).toBeNull();
    expect(rows[3].unparsedEntry).toBe(true);
  });

  it("does not claim a configured policy before the configuration is read", () => {
    const rows = mcpToolRows([tool("github.search")], undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0].configured).toBeUndefined();
  });
});

describe("saved but not yet live", () => {
  it("is false when the node enforces exactly the stored entry", () => {
    const [row] = mcpToolRows([tool("github.search")], config);
    expect(policyAwaitingNode(row, config)).toBe(false);
  });

  it("is true when the stored action or grant differs from the node", () => {
    const granted = {
      ...config,
      policy: { tools: { "github.search": { action: "allow", allowed_groups: ["eng"] } } },
    };
    const [row] = mcpToolRows([tool("github.search")], granted);
    expect(policyAwaitingNode(row, granted)).toBe(true);

    const [sameGrant] = mcpToolRows([tool("github.search", { allowed_groups: ["eng"] })], granted);
    expect(policyAwaitingNode(sameGrant, granted)).toBe(false);

    const denied = { ...config, policy: { tools: { "github.search": { action: "deny" } } } };
    const [deniedRow] = mcpToolRows([tool("github.search")], denied);
    expect(policyAwaitingNode(deniedRow, denied)).toBe(true);
  });

  it("compares a removed entry against the default action", () => {
    const removed = { mode: "aggregate_router", policy: { default_action: "deny", tools: {} } };
    const node = tool("github.search", {
      policy: { action: "deny", configured: false, effective: "hidden_until_configured", listed: false, callable: false },
    });
    const [row] = mcpToolRows([node], removed);
    expect(policyAwaitingNode(row, removed)).toBe(false);
    const [stillConfigured] = mcpToolRows([tool("github.search")], removed);
    expect(policyAwaitingNode(stillConfigured, removed)).toBe(true);
  });
});

describe("catalog state explanations", () => {
  it("points a control plane at its data planes instead of showing an empty catalog", () => {
    const text = catalogStateExplanation("not_served", "cp");
    expect(text).toContain("control plane");
    expect(text).toContain("node-local");
    expect(text).toContain("data plane that serves this proxy's namespace");
  });

  it("explains not_served on a data plane and on a standalone node", () => {
    expect(catalogStateExplanation("not_served", "dp")).toContain("This data plane does not run");
    expect(catalogStateExplanation("not_served", "database")).toContain("not live on this node yet");
    expect(catalogStateExplanation("not_served", null)).toContain("node-local");
  });

  it("explains the other states", () => {
    expect(catalogStateExplanation("not_refreshed", "database")).toContain("No MCP session");
    expect(catalogStateExplanation("unmediated", "database")).toContain("transparent_proxy");
    expect(catalogStateExplanation("stale", "database")).toContain("cache TTL");
  });
});
