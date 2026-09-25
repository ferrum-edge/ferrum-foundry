/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin API functions                             */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  PluginConfig,
  PluginConfigCreate,
} from "./types";
import {
  conditionalDelete,
  conditionalPut,
  readTagged,
  type WriteGuard,
} from "./conditionalWrite";
import {
  baselineSnapshot,
  PLUGIN_BASELINE_OMIT,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";
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

export interface PluginConfigListParams extends PaginationParams {
  /**
   * `proxy_id` exact match (Ferrum Edge v0.9.7, ferrum-edge#5726). The gateway
   * paginates the filtered set; use `listConfigsForProxy`, which checks that
   * the filter was applied.
   */
  proxyId?: string;
}

export async function listConfigs(
  scope: NamespaceScope,
  params: PluginConfigListParams = {},
  signal?: AbortSignal,
): Promise<PaginatedResponse<PluginConfig>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);
  if (params.proxyId !== undefined) searchParams.proxy_id = params.proxyId;

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

/** A `?proxy_id=` listing that returned a configuration for another proxy. */
export class ProxyFilterNotAppliedError extends Error {
  constructor(readonly proxyId: string) {
    super(
      `The gateway did not filter plugin configurations by proxy_id "${proxyId}"; ` +
        "listing one proxy's configurations needs Ferrum Edge v0.9.7 or later",
    );
    this.name = "ProxyFilterNotAppliedError";
  }
}

/**
 * Every proxy-scoped configuration whose `proxy_id` is `proxyId`, including
 * disabled ones and ones the proxy does not list in `plugins`.
 *
 * `GET /plugins/config?proxy_id=` paginates the filtered set, so this walks
 * that proxy's configurations, never the namespace. It is not an
 * effective-policy answer: global and proxy-group configurations also run on
 * a proxy and carry no `proxy_id`. A gateway that ignored the filter would
 * answer with the whole namespace, so the first record for another proxy
 * fails the read instead of being shown or traversed past.
 */
export async function listConfigsForProxy(
  scope: NamespaceScope,
  proxyId: string,
  signal?: AbortSignal,
): Promise<PluginConfig[]> {
  return collectAllPages(
    async (offset, limit, pageSignal) => {
      const page = await listConfigs(scope, { offset, limit, proxyId }, pageSignal);
      if (page.data.some((config) => config.proxy_id !== proxyId)) {
        throw new ProxyFilterNotAppliedError(proxyId);
      }
      return page;
    },
    undefined,
    signal,
  );
}

export async function getConfig(
  scope: NamespaceScope,
  id: string,
  silentErrors = false,
): Promise<PluginConfig> {
  return (await readTagged<PluginConfig>(scope, `plugins/config/${id}`, { silentErrors })).value;
}

/** Reduce a plugin configuration, or a payload, to the content a save replaces. */
export function toBaseline(plugin: PluginConfig | PluginConfigCreate): BaselineSnapshot {
  return baselineSnapshot(plugin, PLUGIN_BASELINE_OMIT);
}

/** The guard a plugin editor builds from the configuration it was seeded with. */
export function pluginWriteGuard(
  seed: PluginConfig,
): WriteGuard<PluginConfig | PluginConfigCreate> {
  return { baseline: toBaseline(seed), select: toBaseline };
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

/**
 * Full-replacement `PUT`, conditional on `ifMatch` when there is one.
 *
 * Plugin configurations are written by the membership plan
 * (`src/lib/pluginMembership.ts`), which compares its own fresh reads and
 * passes `validatorOf(thatRead)`; the editor's baseline is checked inside the
 * plan, not here.
 */
export async function updateConfig(
  scope: NamespaceScope,
  id: string,
  data: PluginConfigCreate,
  ifMatch: string | null,
): Promise<PluginConfig> {
  return conditionalPut<PluginConfig>(
    scope,
    `plugins/config/${id}`,
    withPluginConfigId(data, id),
    ifMatch,
  );
}

/** `DELETE`, conditional on `ifMatch` when there is one; see `updateConfig`. */
export async function removeConfig(
  scope: NamespaceScope,
  id: string,
  ifMatch: string | null,
): Promise<void> {
  await conditionalDelete(scope, `plugins/config/${id}`, ifMatch);
}
