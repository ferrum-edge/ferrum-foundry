/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – where Ferrum Edge refuses a masked placeholder    */
/*                                                                    */
/*  Edge v0.9.9 (ferrum-edge#5925) refuses a write only where the     */
/*  caller's own read projection masks a field and the value sent     */
/*  there is a placeholder: never for `admin`, whose reads are raw,   */
/*  and for other roles only at the sites the projection renders.     */
/*  This module replays that projection over a body to find those     */
/*  sites, so an editor blocks exactly what Edge would refuse and     */
/*  only warns about a placeholder-shaped value anywhere else.        */
/* ------------------------------------------------------------------ */

import type { GatewayRole } from "@/lib/capabilities";
import {
  isRedactionPlaceholder,
  PLUGIN_CONFIG_POINTER,
  pluginConfigPlaceholderPointers,
  pointerSegment,
  REDACTED_PLACEHOLDER,
  upstreamPlaceholderPointers,
} from "./maskedSecrets";
import {
  KAFKA_SAFE_PRODUCER_PROPERTIES,
  PLUGIN_SENSITIVITY,
  type Sensitivity,
} from "./pluginSensitivity";
import { isEdgeSensitiveConfigKey, normalizeConfigKey } from "./secretRedaction";

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

type Container = Record<string, unknown> | unknown[];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function memberOf(holder: Container, key: string | number): unknown {
  return (holder as Record<string | number, unknown>)[key];
}

/** Edge's `url_without_userinfo` precondition: a URL with a username or password. */
function carriesUserinfo(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

/**
 * The sites in a plugin `config` where Edge's non-admin projection
 * (`project_plugin_config_with` at v0.9.9) renders a value and the value sent
 * is a placeholder: the pointers its `PlaceholderSiteRecorder` would report.
 *
 * The projection is replayed layer by layer over a copy, as Edge runs it, so
 * a later layer sees what an earlier one rendered: the plugin's schema rules
 * (`PLUGIN_SENSITIVITY`, CI-checked against Edge), then the name floor
 * (`isEdgeSensitiveConfigKey`, without the deployment's
 * `FERRUM_LOG_REDACT_METADATA_KEYS` extras, which Foundry cannot see), then
 * the URL-userinfo sweep. Only a site's first visit counts. A container a rule
 * renders wholesale is a site of its own; what was inside it is not.
 *
 * A plugin the table does not name may be a built-in added after Foundry's
 * copy was taken, whose rules Foundry cannot know, so every placeholder in its
 * config counts.
 */
export function pluginConfigRefusedSites(pluginName: string, config: unknown): string[] {
  const rules = PLUGIN_SENSITIVITY.get(pluginName);
  if (!rules) return pluginConfigPlaceholderPointers(config);
  if (config === null || config === undefined) return [];

  const sites: string[] = [];
  const visited = new Set<string>();
  const root: Record<string, unknown> = {
    config: JSON.parse(JSON.stringify(config)) as unknown,
  };

  // Every rendered form is a string, so no later layer descends below a site.
  const render = (holder: Container, key: string | number, pointer: string) => {
    if (!visited.has(pointer)) {
      visited.add(pointer);
      if (isRedactionPlaceholder(memberOf(holder, key))) sites.push(pointer);
    }
    (holder as Record<string | number, unknown>)[key] = REDACTED_PLACEHOLDER;
  };

  const applySensitivity = (
    holder: Container,
    key: string | number,
    pointer: string,
    sensitivity: Sensitivity,
  ) => {
    const value = memberOf(holder, key);
    if (value === null || value === undefined) return;
    if (sensitivity === "kafka" && isObject(value)) {
      for (const property of Object.keys(value)) {
        if (KAFKA_SAFE_PRODUCER_PROPERTIES.has(property.trim().toLowerCase())) continue;
        applySensitivity(value, property, `${pointer}/${pointerSegment(property)}`, "secret");
      }
      return;
    }
    render(holder, key, pointer);
  };

  const applyRule = (
    holder: Container,
    key: string | number,
    pointer: string,
    path: readonly string[],
    sensitivity: Sensitivity,
  ) => {
    if (path.length === 0) {
      applySensitivity(holder, key, pointer, sensitivity);
      return;
    }
    const [head, ...rest] = path;
    const value = memberOf(holder, key);
    if (Array.isArray(value)) {
      // `*` names each element; a named segment passes through the array.
      const next = head === "*" ? rest : path;
      value.forEach((_, index) => applyRule(value, index, `${pointer}/${index}`, next, sensitivity));
    } else if (isObject(value)) {
      const wanted = head === "*" ? null : normalizeConfigKey(head);
      for (const child of Object.keys(value)) {
        if (wanted !== null && normalizeConfigKey(child) !== wanted) continue;
        applyRule(value, child, `${pointer}/${pointerSegment(child)}`, rest, sensitivity);
      }
    } else if (value !== null && value !== undefined) {
      // A scalar where the rule expects a container fails closed.
      applySensitivity(holder, key, pointer, "secret");
    }
  };

  const byName = (value: unknown, pointer: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => byName(item, `${pointer}/${index}`));
    } else if (isObject(value)) {
      for (const child of Object.keys(value)) {
        const childPointer = `${pointer}/${pointerSegment(child)}`;
        if (isEdgeSensitiveConfigKey(child)) {
          applySensitivity(value, child, childPointer, "secret");
        } else if (normalizeConfigKey(child) === "redisurl") {
          applySensitivity(value, child, childPointer, "redis");
        } else {
          byName(value[child], childPointer);
        }
      }
    }
  };

  const sweep = (holder: Container, key: string | number, pointer: string) => {
    const value = memberOf(holder, key);
    if (Array.isArray(value)) {
      value.forEach((_, index) => sweep(value, index, `${pointer}/${index}`));
    } else if (isObject(value)) {
      for (const child of Object.keys(value)) {
        sweep(value, child, `${pointer}/${pointerSegment(child)}`);
      }
    } else if (typeof value === "string" && carriesUserinfo(value)) {
      render(holder, key, pointer);
    }
  };

  if (!isObject(root.config)) {
    // No built-in accepts a scalar or array config; Edge withholds it whole.
    render(root, "config", PLUGIN_CONFIG_POINTER);
    return sites;
  }
  for (const rule of rules) {
    applyRule(root, "config", PLUGIN_CONFIG_POINTER, rule.path, rule.sensitivity);
  }
  byName(root.config, PLUGIN_CONFIG_POINTER);
  sweep(root, "config", PLUGIN_CONFIG_POINTER);
  return sites;
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
