/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin API functions                             */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, SILENT_ERRORS, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  PluginConfig,
  PluginConfigCreate,
} from "./types";
import {
  collectAllPages,
  collectBoundedPages,
  SUMMARY_SCAN_BUDGET,
  type BoundedCollection,
} from "./pagination";

function withPluginConfigId(
  data: PluginConfigCreate,
  id?: string,
): PluginConfigCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

/** List available plugin names (built-in registry). */
export async function listAvailable(scope: NamespaceScope): Promise<string[]> {
  return proxyApi.get("plugins", scoped(scope)).json<string[]>();
}

// ── Plugin config CRUD ───────────────────────────────────────────

export async function listConfigs(
  scope: NamespaceScope,
  params: PaginationParams = {},
  signal?: AbortSignal,
): Promise<PaginatedResponse<PluginConfig>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("plugins/config", scoped(scope, { searchParams, signal }))
    .json<PaginatedResponse<PluginConfig>>();
}

/**
 * Every page is fetched under `scope`, however long the collection takes.
 *
 * Reserved for the effective-policy analysis, whose answer is an authorization
 * conclusion: a partial plugin graph would under-report what runs on a proxy,
 * so it is complete or it is unknown. A summary column uses
 * `listBoundedConfigs` instead.
 */
export async function listAllConfigs(
  scope: NamespaceScope,
  signal?: AbortSignal,
): Promise<PluginConfig[]> {
  return collectAllPages(
    (offset, limit, pageSignal) => listConfigs(scope, { offset, limit }, pageSignal),
    undefined,
    signal,
  );
}

/**
 * Traverse plugin configurations up to a budget for a summary view.
 *
 * `complete: false` means the caller must present the summary as unavailable
 * at this collection size, not as a smaller number.
 */
export async function listBoundedConfigs(
  scope: NamespaceScope,
  signal?: AbortSignal,
  budget = SUMMARY_SCAN_BUDGET,
): Promise<BoundedCollection<PluginConfig>> {
  return collectBoundedPages(
    (offset, limit, pageSignal) => listConfigs(scope, { offset, limit }, pageSignal),
    { budget, signal },
  );
}

export async function getConfig(
  scope: NamespaceScope,
  id: string,
  silentErrors = false,
): Promise<PluginConfig> {
  return proxyApi
    .get(
      `plugins/config/${id}`,
      scoped(scope, { context: { [SILENT_ERRORS]: silentErrors } }),
    )
    .json<PluginConfig>();
}

export function toUpdatePayload(plugin: PluginConfig): PluginConfigCreate {
  const { created_at, updated_at, namespace, api_spec_id, ...rest } = plugin;
  void created_at;
  void updated_at;
  void namespace;
  void api_spec_id;
  return rest;
}

export async function createConfig(
  scope: NamespaceScope,
  data: PluginConfigCreate,
): Promise<PluginConfig> {
  return proxyApi
    .post("plugins/config", scoped(scope, { json: withPluginConfigId(data) }))
    .json<PluginConfig>();
}

export async function updateConfig(
  scope: NamespaceScope,
  id: string,
  data: PluginConfigCreate,
): Promise<PluginConfig> {
  return proxyApi
    .put(
      `plugins/config/${id}`,
      scoped(scope, { json: withPluginConfigId(data, id) }),
    )
    .json<PluginConfig>();
}

export async function removeConfig(
  scope: NamespaceScope,
  id: string,
): Promise<void> {
  await proxyApi.delete(`plugins/config/${id}`, scoped(scope));
}
