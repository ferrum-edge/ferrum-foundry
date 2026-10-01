/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – where Ferrum Edge refuses a masked placeholder    */
/*                                                                    */
/*  Edge v0.9.9 (ferrum-edge#5925) refuses a write only where the     */
/*  caller's own read projection masks a field and the value sent     */
/*  there is a placeholder: never for `admin`, whose reads are raw,   */
/*  and for other roles only at the sites the projection renders.     */
/*  This module replays that projection over a body to find those     */
/*  sites, so an editor blocks exactly what Edge would refuse and     */
/*  only warns about a placeholder-shaped value anywhere else. The    */
/*  replay is `refusedPlaceholderSites` in `maskedSecrets.ts`.        */
/* ------------------------------------------------------------------ */

import type { GatewayRole } from "@/lib/capabilities";
import {
  pluginConfigPlaceholderPointers,
  refusedPlaceholderSites,
  upstreamPlaceholderPointers,
} from "./maskedSecrets";
import { KAFKA_SAFE_PRODUCER_PROPERTIES, PLUGIN_SENSITIVITY } from "./pluginSensitivity";

/** Placeholder-shaped values in a body, split by what Edge does with them. */
export interface PlaceholderSites {
  /**
   * Sites Edge refuses for this role: the caller's read masks the field, so
   * the value is the marker it was shown. Save is blocked until each is
   * re-entered or cleared.
   */
  readonly blocking: readonly string[];
  /**
   * Values that match a placeholder but sit where this role's read shows the
   * stored value verbatim. Edge stores them as written; a warning, not a block.
   */
  readonly other: readonly string[];
}

/**
 * `refusedPlaceholderSites` under Foundry's copy of Edge's sensitivity table
 * (`PLUGIN_SENSITIVITY`, CI-checked against Edge): the sites in a plugin
 * `config` Edge refuses for a non-admin role.
 */
export function pluginConfigRefusedSites(pluginName: string, config: unknown): string[] {
  return refusedPlaceholderSites(
    PLUGIN_SENSITIVITY.get(pluginName),
    KAFKA_SAFE_PRODUCER_PROPERTIES,
    config,
  );
}

function split(all: readonly string[], refused: readonly string[]): PlaceholderSites {
  const blocking = new Set(refused);
  return {
    blocking: all.filter((pointer) => blocking.has(pointer)),
    other: all.filter((pointer) => !blocking.has(pointer)),
  };
}

/**
 * Every placeholder in a plugin `config`, split into the sites Edge refuses
 * for `role` and the rest. `admin` reads are raw, so nothing is refused for
 * an admin. An unknown role (`null`) is treated as a non-admin one, so the
 * editor never lets through a write Edge might refuse.
 */
export function pluginConfigPlaceholderSites(
  pluginName: string,
  config: unknown,
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const all = pluginConfigPlaceholderPointers(config);
  if (all.length === 0) return { blocking: [], other: [] };
  return split(all, role === "admin" ? [] : pluginConfigRefusedSites(pluginName, config));
}

/**
 * The upstream equivalent. An `operator` read masks only the Consul ACL token;
 * an `admin` read masks nothing.
 */
export function upstreamPlaceholderSites(
  upstream: Parameters<typeof upstreamPlaceholderPointers>[0],
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const all = upstreamPlaceholderPointers(upstream);
  return split(all, role === "admin" ? [] : all);
}
