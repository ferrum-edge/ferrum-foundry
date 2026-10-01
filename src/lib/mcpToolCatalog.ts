/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – presenting an mcp_gateway tool catalog            */
/*                                                                    */
/*  The catalog (`GET /proxies/{id}/mcp/tools`) is what the running    */
/*  gateway node has cached; the plugin configuration is what is       */
/*  stored. The Tools panel shows both, side by side, and never lets   */
/*  one stand in for the other: a policy that was just saved is        */
/*  "configured" at once and "effective" only once the node reports    */
/*  it, and a tool the configuration names but the node has not        */
/*  discovered is listed as exactly that.                              */
/* ------------------------------------------------------------------ */

import type { McpCatalogState, McpToolCatalogTool, McpToolsRefresh } from "@/api/mcpTools";
import {
  configuredToolPolicies,
  defaultToolAction,
  parseToolPolicy,
  type McpToolAction,
  type McpToolPolicyEntry,
} from "./mcpToolPolicy";

/** One tool in the panel: discovered by the node, configured, or both. */
export interface McpToolRow {
  name: string;
  /** The node's catalog entry, or `null` when this node has not discovered it. */
  tool: McpToolCatalogTool | null;
  /**
   * The stored `policy.tools` entry: `undefined` while the configuration has
   * not been read, `null` when it names no entry for this tool.
   */
  configured: McpToolPolicyEntry | null | undefined;
  /** The stored entry is present but has a shape Foundry cannot edit. */
  unparsedEntry: boolean;
}

/**
 * Discovered tools in catalog order, then tools the configuration names that
 * this node has not discovered, by name. `config` is `undefined` while the
 * plugin configuration has not been read.
 */
export function mcpToolRows(
  tools: readonly McpToolCatalogTool[],
  config: Record<string, unknown> | undefined,
): McpToolRow[] {
  const entries = config === undefined ? undefined : configuredToolPolicies(config);
  const describe = (name: string) => {
    if (entries === undefined) return { configured: undefined, unparsedEntry: false };
    if (!Object.hasOwn(entries, name)) return { configured: null, unparsedEntry: false };
    const parsed = parseToolPolicy(entries[name]);
    return { configured: parsed, unparsedEntry: parsed === null };
  };
  const discovered = new Set(tools.map((tool) => tool.name));
  const rows: McpToolRow[] = tools.map((tool) => ({ name: tool.name, tool, ...describe(tool.name) }));
  if (entries) {
    for (const name of Object.keys(entries).filter((key) => !discovered.has(key)).sort()) {
      rows.push({ name, tool: null, ...describe(name) });
    }
  }
  return rows;
}

function sameGroups(left: readonly string[] | null | undefined, right: readonly string[] | null): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((group, index) => group === b[index]);
}

/**
 * The stored policy for a discovered tool differs from what the node runs:
 * the save is committed, and this node has not loaded it yet (or a
 * configuration change is waiting to go live).
 */
export function policyAwaitingNode(row: McpToolRow, config: Record<string, unknown>): boolean {
  if (!row.tool || row.configured === undefined || row.unparsedEntry) return false;
  const action: McpToolAction = row.configured?.action ?? defaultToolAction(config);
  if (action !== row.tool.policy.action) return true;
  if (row.tool.policy.configured !== (row.configured !== null)) return true;
  const allowed = row.configured?.action === "allow" ? row.configured.allowed_groups ?? null : null;
  const denied = row.configured?.action === "allow" ? row.configured.denied_groups ?? [] : [];
  return !sameGroups(allowed, row.tool.allowed_groups) || !sameGroups(denied, row.tool.denied_groups);
}

export const CATALOG_STATE_LABELS: Record<McpCatalogState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  not_refreshed: "Not refreshed",
  unmediated: "Unmediated",
  not_served: "Not served here",
};

export const TOOLS_REFRESH_LABELS: Record<McpToolsRefresh, string> = {
  ok: "Listed",
  stale: "Refresh failed (last good)",
  failed: "Refresh failed",
  pending: "Not listed yet",
  not_listed: "Not aggregated",
  disabled: "Disabled",
};

export const EFFECTIVE_LABELS: Record<McpToolCatalogTool["policy"]["effective"], string> = {
  allow: "Allowed",
  deny: "Denied",
  hide_from_discovery: "Hidden from discovery",
  hidden_until_configured: "Hidden until configured",
  hidden_schema_changed: "Hidden: schema changed",
};

/**
 * Why an instance reports no catalog here, in terms of the gateway this
 * Foundry is connected to (`health.mode`, `null` when it was not read).
 *
 * The catalog is node-local. Foundry talks to one admin API, so on a control
 * plane — where every instance is `not_served` — it says so and points at the
 * data planes instead of presenting an empty tool list as the answer.
 */
export function catalogStateExplanation(
  state: McpCatalogState,
  gatewayMode: string | null,
): string {
  switch (state) {
    case "fresh":
      return "Refreshed within its cache TTL.";
    case "stale":
      return "Older than its cache TTL; the next MCP request on this node refreshes it.";
    case "not_refreshed":
      return (
        "No MCP session on this node has listed tools yet, so there is no catalog to show. " +
        "The first tools/list through the endpoint discovers them."
      );
    case "unmediated":
      return (
        "A transparent_proxy instance forwards MCP traffic to one upstream without a " +
        "catalog, so it has no tools or tool policy to show."
      );
    case "not_served":
      if (gatewayMode === "cp") {
        return (
          "Foundry is connected to a control plane. The tool catalog is node-local and a " +
          "control plane runs no data plane, so it never holds one. Each data plane reports " +
          "its own catalog on its own admin API: connect a Foundry deployment to a data plane " +
          "that serves this proxy's namespace to see the discovered tools. The configured " +
          "policy below is read from the stored plugin configuration."
        );
      }
      if (gatewayMode === "dp") {
        return (
          "This data plane does not run an instance for the proxy: it serves another " +
          "namespace, or the change is not live on this node yet. The tool catalog is " +
          "node-local; query a data plane that serves this proxy's namespace."
        );
      }
      return (
        "This gateway node does not run an instance for the proxy: it does not serve the " +
        "proxy's namespace, or the change is not live on this node yet. The tool catalog is " +
        "node-local and only a node that serves the proxy has one."
      );
  }
}
