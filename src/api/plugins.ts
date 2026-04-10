/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin API functions                             */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  PluginConfig,
  PluginConfigCreate,
} from "./types";

function withPluginConfigId(
  data: PluginConfigCreate,
  id?: string,
): PluginConfigCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

/** List available plugin names (built-in registry). */
export async function listAvailable(): Promise<string[]> {
  return proxyApi.get("plugins").json<string[]>();
}

// ── Plugin config CRUD ───────────────────────────────────────────

export async function listConfigs(
  params: PaginationParams = {},
): Promise<PaginatedResponse<PluginConfig>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("plugins/config", { searchParams })
    .json<PaginatedResponse<PluginConfig>>();
}

export async function getConfig(id: string): Promise<PluginConfig> {
  return proxyApi.get(`plugins/config/${id}`).json<PluginConfig>();
}

export async function createConfig(
  data: PluginConfigCreate,
): Promise<PluginConfig> {
  return proxyApi
    .post("plugins/config", { json: withPluginConfigId(data) })
    .json<PluginConfig>();
}

export async function updateConfig(
  id: string,
  data: PluginConfigCreate,
): Promise<PluginConfig> {
  return proxyApi
    .put(`plugins/config/${id}`, { json: withPluginConfigId(data, id) })
    .json<PluginConfig>();
}

export async function removeConfig(id: string): Promise<void> {
  await proxyApi.delete(`plugins/config/${id}`);
}
