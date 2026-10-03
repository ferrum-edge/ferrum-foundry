/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – mcp_gateway tool catalog and per-tool policy      */
/*                                                                    */
/*  `GET /proxies/{id}/mcp/tools` (Ferrum Edge v0.9.9,                 */
/*  ferrum-edge#5949) reads the tool catalog the proxy's running       */
/*  `mcp_gateway` instances already cached. It never speaks MCP to an  */
/*  upstream, and it is NODE-LOCAL: a control plane, or a data plane   */
/*  that does not serve the proxy, answers every instance with         */
/*  `catalog_state: not_served` and no tools. Every role receives the  */
/*  same projection. Foundry talks to one admin API, so it reports     */
/*  that state as it is rather than guessing at another node's view.   */
/*                                                                    */
/*  Policy edits are not a catalog write: they replace one             */
/*  `config.policy.tools` entry of the plugin configuration, through   */
/*  the same verify-then-`If-Match` path as every other full-replace   */
/*  save (`guardedReplace`).                                           */
/* ------------------------------------------------------------------ */

import { isHTTPError } from "ky";
import {
  extractApiErrorData,
  HANDLED_STATUSES,
  proxyApi,
  scoped,
  type NamespaceScope,
} from "./client";
import {
  guardedReplace,
  readTagged,
  uncomparedGuard,
  type WriteGuard,
} from "./conditionalWrite";
import { MaskedSecretWriteError } from "./maskedSecrets";
import { pluginConfigPlaceholderSites } from "./maskedSecretSites";
import * as pluginsApi from "./plugins";
import { pathSegment } from "./pathSegment";
import type { PluginConfig, PluginConfigCreate } from "./types";
import type { GatewayRole } from "@/lib/capabilities";
import type { BaselineSnapshot } from "@/lib/resourceBaseline";
import {
  rawToolPolicy,
  validateToolPolicy,
  withToolPolicy,
  type McpToolAction,
  type McpToolPolicyEntry,
} from "@/lib/mcpToolPolicy";

/* ---------- Response shapes (openapi.yaml `McpToolCatalog*`, v0.9.9) ---------- */

export type McpCatalogState = "fresh" | "stale" | "not_refreshed" | "unmediated" | "not_served";

export type McpToolsRefresh = "ok" | "stale" | "failed" | "pending" | "not_listed" | "disabled";

export type McpToolEffective =
  | McpToolAction
  | "hidden_until_configured"
  | "hidden_schema_changed";

export interface McpToolCatalogServer {
  server_id: string;
  namespace: string;
  kind: "mcp" | "openapi";
  /** `scheme://host[:port]` plus `/[REDACTED_PATH]`, for every role; `null` for openapi. */
  upstream_url: string | null;
  enabled: boolean;
  expose_tools: boolean;
  tools_refresh: McpToolsRefresh;
  /** Fixed text for `stale` and `failed`, never an upstream error body. */
  refresh_error: string | null;
}

/**
 * One `mcp_gateway` instance's cached catalog. A `not_served` instance carries
 * only `plugin_config_id`, `catalog_state`, `refreshed_at`, `stale`,
 * `tool_count`, and an empty `servers` list.
 */
export interface McpToolCatalog {
  plugin_config_id: string;
  catalog_state: McpCatalogState;
  mode?: "aggregate_router" | "transparent_proxy";
  enabled?: boolean;
  endpoint_path?: string;
  refreshed_at: string | null;
  stale: boolean;
  cache_ttl_seconds?: number;
  catalog_version?: number | null;
  cached_sessions?: number;
  tool_count: number;
  tools_unavailable?: boolean;
  discovery?: {
    on_new_tool: "allow" | "hide_until_configured";
    on_schema_change: "allow" | "hide_until_configured";
  };
  policy?: {
    default_action: "allow" | "deny";
    hide_denied_tools: boolean;
  };
  limits?: {
    max_catalog_items_per_list: number;
    max_catalog_bytes_per_list: number;
  };
  servers: McpToolCatalogServer[];
}

export interface McpToolSource {
  type: "upstream" | "openapi";
  server_id: string;
  namespace: string;
  /** The tool name the upstream MCP server lists (`upstream`). */
  upstream_name?: string;
  /** The generating OpenAPI operation (`openapi`). */
  operation_name?: string;
  method?: string;
  path?: string;
}

export interface McpToolCatalogTool {
  /** Public namespaced name, as `tools/list` publishes it. */
  name: string;
  plugin_config_id: string;
  title: string | null;
  description: string | null;
  annotations: Record<string, unknown> | null;
  source: McpToolSource;
  policy: {
    action: McpToolAction;
    configured: boolean;
    effective: McpToolEffective;
    /** Listed for a consumer its grant admits; bridge tools also honour `allowed_methods`. */
    listed: boolean;
    callable: boolean;
  };
  /** `null` when every consumer is admitted subject to the action. */
  allowed_groups: string[] | null;
  denied_groups: string[];
  /** Lowercase hex SHA-256 of the tool's schema, as the gateway stores it. */
  schema_hash: string;
  discovered_at: string;
}

export interface McpToolCatalogResponse {
  proxy_id: string;
  namespace: string;
  refreshed_at: string | null;
  stale: boolean;
  catalogs: McpToolCatalog[];
  data: McpToolCatalogTool[];
  pagination: { offset: number; limit: number; total: number };
}

/* ---------- Catalog read ---------- */

/** Edge's answer for a proxy no enabled `mcp_gateway` applies to. */
export const NO_MCP_GATEWAY_MESSAGE = "Proxy has no mcp_gateway plugin";

/** The largest page the shared pagination bounds allow. */
export const MCP_CATALOG_PAGE_LIMIT = 1000;

/**
 * Pages read before the catalog is reported unavailable. Each instance is
 * already bounded by `validation.max_catalog_items_per_list`, so a proxy whose
 * instances together list more than this is not something a table can show.
 */
export const MCP_CATALOG_MAX_PAGES = 10;

/** The catalog moved between two of its pages; the read is not one catalog. */
export class McpCatalogChangedError extends Error {
  constructor(proxyId: string) {
    super(
      `The MCP tool catalog for proxy ${proxyId} changed while it was being read. ` +
        "Retry to read it again.",
    );
    this.name = "McpCatalogChangedError";
  }
}

function catalogVersions(response: McpToolCatalogResponse): string {
  return JSON.stringify(
    response.catalogs.map((catalog) => [catalog.plugin_config_id, catalog.catalog_version ?? null]),
  );
}

function isCatalogResponse(value: unknown): value is McpToolCatalogResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const pagination = record.pagination as Record<string, unknown> | undefined;
  return (
    Array.isArray(record.catalogs) &&
    Array.isArray(record.data) &&
    typeof pagination === "object" &&
    pagination !== null &&
    typeof pagination.total === "number"
  );
}

async function readCatalogPage(
  scope: NamespaceScope,
  proxyId: string,
  offset: number,
  signal?: AbortSignal,
): Promise<McpToolCatalogResponse> {
  const page: unknown = await proxyApi
    .get(
      `proxies/${pathSegment(proxyId)}/mcp/tools`,
      scoped(scope, {
        searchParams: { offset: String(offset), limit: String(MCP_CATALOG_PAGE_LIMIT) },
        signal,
        // A proxy without `mcp_gateway` is a documented answer, not a fault.
        context: { [HANDLED_STATUSES]: [404] },
      }),
    )
    .json();
  if (!isCatalogResponse(page) || page.proxy_id !== proxyId) {
    throw new Error("Ferrum Edge returned a malformed MCP tool catalog response");
  }
  return page;
}

/**
 * The proxy's whole cached catalog, or `null` when no enabled `mcp_gateway`
 * applies to it.
 *
 * Every page is read, and a catalog that changed between pages (another
 * total, or another `catalog_version` on any instance) fails the read instead
 * of mixing two catalogs into one table: the tool list is complete or it is
 * unknown.
 */
export async function getToolCatalog(
  scope: NamespaceScope,
  proxyId: string,
  signal?: AbortSignal,
): Promise<McpToolCatalogResponse | null> {
  let first: McpToolCatalogResponse;
  try {
    first = await readCatalogPage(scope, proxyId, 0, signal);
  } catch (error) {
    if (
      isHTTPError(error) &&
      error.response.status === 404 &&
      extractApiErrorData(error.data) === NO_MCP_GATEWAY_MESSAGE
    ) {
      return null;
    }
    throw error;
  }

  const tools = [...first.data];
  const versions = catalogVersions(first);
  for (let pages = 1; tools.length < first.pagination.total; pages += 1) {
    if (pages >= MCP_CATALOG_MAX_PAGES) {
      throw new Error(
        `The MCP tool catalog for proxy ${proxyId} lists more than ` +
          `${MCP_CATALOG_MAX_PAGES * MCP_CATALOG_PAGE_LIMIT} tools, more than Foundry reads.`,
      );
    }
    const next = await readCatalogPage(scope, proxyId, tools.length, signal);
    if (
      next.pagination.total !== first.pagination.total ||
      catalogVersions(next) !== versions ||
      next.data.length === 0
    ) {
      throw new McpCatalogChangedError(proxyId);
    }
    tools.push(...next.data);
  }
  return {
    ...first,
    data: tools,
    pagination: { offset: 0, limit: tools.length, total: first.pagination.total },
  };
}

/* ---------- Per-tool policy write ---------- */

/**
 * What an operator blocked by masked values can do. A server's
 * `upstream_url` is required (Edge refuses a server without `upstream_url` or
 * `openapi`) and is not a secret, so it cannot be cleared: it has to be
 * re-entered. Any other masked value may be re-entered or cleared.
 */
export function maskedToolPolicyAdvice(pointers: readonly string[]): string {
  const isUrl = (pointer: string) => pointer.endsWith("/upstream_url");
  if (pointers.length > 0 && pointers.every(isUrl)) {
    return "Re-enter the URL on the plugin page first, or have an admin make the change.";
  }
  if (pointers.some(isUrl)) {
    return (
      "Re-enter them on the plugin page first (a server URL must be re-entered; other " +
      "values may instead be cleared, which deletes the stored secret), or have an admin " +
      "make the change."
    );
  }
  return (
    "Re-enter or clear them on the plugin page first (clearing deletes the stored " +
    "secret), or have an admin make the change."
  );
}

/** A tool-policy save refused before sending; the message says why. */
export class McpToolPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolPolicyError";
  }
}

function toolPolicySnapshot(
  value: PluginConfig | PluginConfigCreate,
  toolName: string,
): BaselineSnapshot {
  return { [`config.policy.tools.${toolName}`]: rawToolPolicy(value.config, toolName) ?? null };
}

/**
 * The guard for one tool's entry. A policy save owns that entry and nothing
 * else: every other field is rebuilt from the read the save is sent against,
 * so a concurrent change to another tool, a server, or the scope is carried
 * over rather than reverted, while a concurrent change to this tool's entry is
 * refused. Build it from the configuration the operator was looking at when
 * they started the edit, not from a later refetch.
 */
export function toolPolicyWriteGuard(
  seed: PluginConfig,
  toolName: string,
): WriteGuard<PluginConfig | PluginConfigCreate> {
  const select = (value: PluginConfig | PluginConfigCreate) => toolPolicySnapshot(value, toolName);
  return { baseline: select(seed), select };
}

/** The guard for adding an entry the operator believes does not exist yet. */
export function newToolPolicyWriteGuard(
  toolName: string,
): WriteGuard<PluginConfig | PluginConfigCreate> {
  const select = (value: PluginConfig | PluginConfigCreate) => toolPolicySnapshot(value, toolName);
  return { baseline: { [`config.policy.tools.${toolName}`]: null }, select };
}

/**
 * Replace `toolName`'s `policy.tools` entry (or remove it, for `null`, so the
 * instance's `default_action` applies) on an `mcp_gateway` configuration.
 *
 * The body is the fresh read with only that entry changed, sent with
 * `If-Match` from that read. It omits `labels`, which Edge then preserves, so
 * a `provisioned-by` attribution is never rewritten by a policy save. A read
 * that masks a value for this role would carry its placeholder, which Edge
 * refuses (ferrum-edge#5925); such a save is refused here with
 * `MaskedSecretWriteError` before anything is sent.
 */
export async function updateToolPolicy(
  scope: NamespaceScope,
  pluginId: string,
  toolName: string,
  entry: McpToolPolicyEntry | null,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
  role: GatewayRole | null = null,
): Promise<PluginConfig> {
  const path = `plugins/config/${pathSegment(pluginId)}`;
  const propose = (current: PluginConfig): PluginConfigCreate => {
    if (current.plugin_name !== "mcp_gateway") {
      throw new McpToolPolicyError(
        `Plugin configuration ${pluginId} is ${current.plugin_name}, not mcp_gateway.`,
      );
    }
    const problems = validateToolPolicy(current.config, toolName, entry);
    if (problems.length > 0) throw new McpToolPolicyError(problems.join(" "));
    const masked = pluginConfigPlaceholderSites(current.plugin_name, current.config, role).blocking;
    if (masked.length > 0) {
      throw new MaskedSecretWriteError(
        `Tool policy was not saved: plugin configuration ${pluginId} has values hidden from ` +
          `your role (${masked.join(", ")}), and a policy save resends the whole ` +
          `configuration with them. ${maskedToolPolicyAdvice(masked)}`,
        [...masked],
      );
    }
    const { labels: _labels, ...payload } = pluginsApi.toUpdatePayload(current);
    return {
      ...payload,
      id: pluginId,
      config: withToolPolicy(current.config, toolName, entry),
    };
  };

  return guardedReplace<PluginConfig, PluginConfigCreate>({
    resource: "MCP tool policy",
    id: pluginId,
    namespace: scope.namespace,
    // Unguarded, the save still rebuilds every other field from the read it
    // is sent against, so it is conditional on that read's tag.
    guard: guard ?? uncomparedGuard(),
    read: () => readTagged<PluginConfig>(scope, path),
    propose,
    write: (body, ifMatch) => pluginsApi.updateConfig(scope, pluginId, body, ifMatch),
  });
}
