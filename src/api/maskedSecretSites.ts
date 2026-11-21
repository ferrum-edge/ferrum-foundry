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
/*  replay is `refusedPlaceholderSites` in `maskedSecrets.ts`. Edge   */
/*  main (ferrum-edge#7054) also refuses the exact `[REDACTED]` in    */
/*  any string of a non-admin plugin-config write, so that always     */
/*  blocks; only a URL-shaped placeholder can still be a warning.     */
/* ------------------------------------------------------------------ */

import type { GatewayRole } from "@/lib/capabilities";
import { PLUGIN_TRIGGER_POINTER, pluginTriggerWithheldSites } from "@/lib/resourceBaseline";
import {
  MaskedSecretWriteError,
  placeholderPointers,
  pluginConfigPlaceholderPointers,
  proxyPlaceholderPointers,
  type RefusedSite,
  refusedPlaceholderSiteKinds,
  upstreamPlaceholderPointers,
} from "./maskedSecrets";
import { KAFKA_SAFE_PRODUCER_PROPERTIES, PLUGIN_SENSITIVITY } from "./pluginSensitivity";

/** Placeholder-shaped values in a body, split by what Edge does with them. */
export interface PlaceholderSites {
  /**
   * Every site Edge refuses for this role. Save is blocked until each is
   * resolved. Most are masked secrets (the value is the marker the read
   * showed), which may be re-entered or cleared; `sources` and `reserved`
   * name the ones that may only be re-entered.
   */
  readonly blocking: readonly string[];
  /**
   * The blocking sites that are certificate or private-key sources the
   * gateway loads TLS material from (`tls-source`). Each must be re-entered;
   * leaving one out of a full-replacement save would remove the source.
   */
  readonly sources: readonly string[];
  /**
   * The blocking sites Edge refuses only because it reserves the exact
   * `[REDACTED]` in a non-admin plugin-config write (`reserved`,
   * ferrum-edge#7054): the read may show the field verbatim. Each must be
   * re-entered with a real value, never cleared.
   */
  readonly reserved: readonly string[];
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
  return pluginConfigRefusedSiteKinds(pluginName, config).map((site) => site.pointer);
}

function pluginConfigRefusedSiteKinds(pluginName: string, config: unknown): RefusedSite[] {
  return refusedPlaceholderSiteKinds(
    PLUGIN_SENSITIVITY.get(pluginName),
    KAFKA_SAFE_PRODUCER_PROPERTIES,
    config,
  );
}

/** Proxy and upstream sites are all `masked`. */
function split(all: readonly string[], refused: readonly RefusedSite[]): PlaceholderSites {
  const kinds = new Map(refused.map((site) => [site.pointer, site.kind]));
  const blocking = all.filter((pointer) => kinds.has(pointer));
  return {
    blocking,
    sources: blocking.filter((pointer) => kinds.get(pointer) === "tls-source"),
    reserved: blocking.filter((pointer) => kinds.get(pointer) === "reserved"),
    other: all.filter((pointer) => !kinds.has(pointer)),
  };
}

function masked(pointers: readonly string[]): RefusedSite[] {
  return pointers.map((pointer): RefusedSite => ({ pointer, kind: "masked" }));
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
  if (all.length === 0) return { blocking: [], sources: [], reserved: [], other: [] };
  return split(all, role === "admin" ? [] : pluginConfigRefusedSiteKinds(pluginName, config));
}

/**
 * Every placeholder in a plugin `trigger`, split the same way. Edge main
 * (ferrum-edge#7054) withholds a trigger's `header`, `query` and `cookie`
 * operands from a non-admin read and refuses a placeholder sent back at one
 * of them; the pinned v0.9.20 shows a trigger verbatim and would store it as
 * the operand. Either way it blocks: a placeholder at or inside any site
 * Edge main's projection withholds (`pluginTriggerWithheldSites`, which takes
 * a malformed shape whole) is blocking, and one in a visible predicate or a
 * field name, which every read shows as stored, is only a warning. All
 * blocking trigger sites are `masked`, but no editor offers to clear one: an
 * `exact` or `prefix` entry is re-entered, or the trigger removed as a whole.
 *
 * A placeholder inside a site withheld whole (malformed content, whose keys
 * may themselves be the secret) is reported at that site's pointer, once,
 * for every role, so a notice never prints a key the redaction withholds.
 * An ordinary operand site is its own pointer.
 */
export function pluginTriggerPlaceholderSites(
  trigger: unknown,
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const found = placeholderPointers(trigger ?? null, PLUGIN_TRIGGER_POINTER);
  if (found.length === 0) return { blocking: [], sources: [], reserved: [], other: [] };
  const withheld = pluginTriggerWithheldSites(trigger).map((site) => site.pointer);
  const shown = (pointer: string) =>
    withheld.find((site) => pointer.startsWith(`${site}/`)) ?? pointer;
  const all = [...new Set(found.map(shown))];
  const refused = role === "admin" ? [] : all.filter((pointer) => withheld.includes(pointer));
  return split(all, masked(refused));
}

/**
 * Every placeholder Edge refuses (or Foundry blocks) in a whole plugin
 * configuration body for `role`: its `config` (`pluginConfigPlaceholderSites`)
 * and its `trigger` (`pluginTriggerPlaceholderSites`). Use this for any write
 * that resends a plugin read: a tool-policy save or a membership rollback.
 */
export function pluginPlaceholderSites(
  plugin: { readonly plugin_name: string; readonly config?: unknown; readonly trigger?: unknown },
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const config = pluginConfigPlaceholderSites(plugin.plugin_name, plugin.config, role);
  const trigger = pluginTriggerPlaceholderSites(plugin.trigger, role);
  return {
    blocking: [...config.blocking, ...trigger.blocking],
    sources: [...config.sources, ...trigger.sources],
    reserved: [...config.reserved, ...trigger.reserved],
    other: [...config.other, ...trigger.other],
  };
}

/**
 * The upstream equivalent. A non-admin read masks the Consul ACL token and
 * stored TLS private-key material (`upstreamPlaceholderPointers`); an `admin`
 * read masks nothing.
 */
export function upstreamPlaceholderSites(
  upstream: Parameters<typeof upstreamPlaceholderPointers>[0],
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const all = upstreamPlaceholderPointers(upstream);
  return split(all, role === "admin" ? [] : masked(all));
}

/**
 * The proxy equivalent. A non-admin read masks stored TLS private-key
 * material (`proxyPlaceholderPointers`); an `admin` read masks nothing.
 */
export function proxyPlaceholderSites(
  proxy: unknown,
  role: GatewayRole | null | undefined,
): PlaceholderSites {
  const all = proxyPlaceholderPointers(proxy);
  return split(all, role === "admin" ? [] : masked(all));
}

/**
 * Refuse, before anything is sent, a proxy or upstream write whose body still
 * carries a placeholder Edge refuses for `role`: one the editor does not show,
 * or a read-derived write such as a membership plan's proxy update. (An
 * upstream's mesh-projected fields, `port_overrides` and a subset's projected
 * `traffic_policy.tls`, are never sent, so their placeholders never block.)
 * Throws `MaskedSecretWriteError` naming the sites; no value is included.
 */
export function refuseMaskedResourceWrite(
  resource: "Proxy" | "Upstream",
  id: string,
  body: unknown,
  role: GatewayRole | null | undefined,
): void {
  const sites = resource === "Proxy" ? proxyPlaceholderSites : upstreamPlaceholderSites;
  refuseMaskedSites(resource, id, sites(body, role).blocking);
}

function refuseMaskedSites(
  resource: "Proxy" | "Upstream",
  id: string,
  blocking: readonly string[],
): void {
  if (blocking.length === 0) return;
  throw new MaskedSecretWriteError(
    `${resource} ${id} was not saved: ${blocking.join(", ")} still carry the placeholder ` +
      "that reads for your role show in place of a stored secret, and Ferrum Edge refuses it. " +
      "Re-enter or clear each value (clearing deletes the stored secret), or have an admin " +
      "make the change.",
    blocking,
  );
}
