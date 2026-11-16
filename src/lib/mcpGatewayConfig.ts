type JsonObject = { [key: string]: unknown };

export type McpGatewayMode = "aggregate_router" | "transparent_proxy";

/**
 * Keys rejected by the gateway for `mode: transparent_proxy` (presence-based),
 * per `McpGatewayConfig` at Edge v0.9.20 (e4a606a0). The prompt and resource
 * policy keys are new in v0.9.19. Per-server `openapi` and
 * `forward_client_credentials` are refused there too; they sit under
 * operator-named `servers.*` keys, so they stay with the raw JSON editor and
 * Edge admission.
 */
export const MCP_GATEWAY_AGGREGATE_ONLY_PATHS = [
  "policy.default_action",
  "policy.default_prompt_action",
  "policy.default_resource_action",
  "policy.tools",
  "policy.prompts",
  "policy.resources",
  "policy.hide_denied_tools",
  "discovery.aggregate_tools",
  "discovery.aggregate_resources",
  "discovery.aggregate_prompts",
  "discovery.namespace_separator",
  "discovery.cache_ttl_seconds",
  "discovery.hide_denied_items",
  "discovery.on_new_tool",
  "discovery.on_schema_change",
] as const;

export const MCP_GATEWAY_TRANSPARENT_NOTE =
  "Transparent proxy mode cannot include aggregate catalog policy or discovery controls. " +
  "Those fields are omitted from the template and stripped on save.";

const AGGREGATE_FIELD_DEFAULTS: JsonObject = {
  policy: {
    default_action: "deny",
    tools: {
      "github.search_issues": { action: "allow" },
    },
  },
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getAtPath(root: JsonObject, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function deleteAtPath(root: JsonObject, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isPlainObject(current) || !(part in current)) return undefined;
    current = current[part];
  }
  const leaf = parts[parts.length - 1];
  if (!isPlainObject(current) || !(leaf in current)) return undefined;
  const previous = current[leaf];
  delete current[leaf];
  return previous;
}

function setAtPath(root: JsonObject, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: JsonObject = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = current[part];
    if (!isPlainObject(next)) {
      const created: JsonObject = {};
      current[part] = created;
      current = created;
      continue;
    }
    current = next;
  }
  current[parts[parts.length - 1]] = value;
}

function pruneEmptyObjects(root: JsonObject): void {
  for (const [key, value] of Object.entries(root)) {
    if (!isPlainObject(value)) continue;
    pruneEmptyObjects(value);
    if (Object.keys(value).length === 0) {
      delete root[key];
    }
  }
}

function mergeDefined(target: JsonObject, source: JsonObject): JsonObject {
  const next = deepClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = next[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      next[key] = mergeDefined(existing, value);
      continue;
    }
    next[key] = deepClone(value);
  }
  return next;
}

export function readMcpGatewayMode(config: unknown): McpGatewayMode {
  if (!isPlainObject(config)) return "aggregate_router";
  return config.mode === "transparent_proxy" ? "transparent_proxy" : "aggregate_router";
}

export function mcpGatewayConfigHasAggregateOnlyFields(config: unknown): boolean {
  if (!isPlainObject(config)) return false;
  return MCP_GATEWAY_AGGREGATE_ONLY_PATHS.some((path) => getAtPath(config, path) !== undefined);
}

export function pickMcpGatewayAggregateOnlyFields(config: unknown): JsonObject {
  if (!isPlainObject(config)) return {};
  const picked: JsonObject = {};
  for (const path of MCP_GATEWAY_AGGREGATE_ONLY_PATHS) {
    const value = getAtPath(config, path);
    if (value !== undefined) {
      setAtPath(picked, path, deepClone(value));
    }
  }
  return picked;
}

export function omitMcpGatewayAggregateOnlyFields(config: unknown): JsonObject {
  if (!isPlainObject(config)) return {};
  const next = deepClone(config);
  for (const path of MCP_GATEWAY_AGGREGATE_ONLY_PATHS) {
    deleteAtPath(next, path);
  }
  pruneEmptyObjects(next);
  return next;
}

/**
 * Return `config` in aggregate mode.
 *
 * `stash` is the aggregate-only state captured when this editor last left
 * aggregate mode, or `null` when nothing was captured. A captured stash is the
 * operator's own configuration and is restored exactly, even when empty (an
 * aggregate config that relied on the gateway's default policy): merging the
 * sample defaults into it would add a deny-by-default policy with an allow
 * rule the operator never wrote. The sample only seeds a configuration that
 * never had aggregate state here and has no aggregate fields now.
 */
export function applyMcpGatewayAggregateDefaults(
  config: unknown,
  stash: JsonObject | null = null,
): JsonObject {
  const next = isPlainObject(config) ? deepClone(config) : {};
  next.mode = "aggregate_router";
  if (stash !== null) return mergeDefined(next, stash);
  if (mcpGatewayConfigHasAggregateOnlyFields(next)) return next;
  return mergeDefined(next, AGGREGATE_FIELD_DEFAULTS);
}

export function sanitizeMcpGatewayConfigForSubmit(config: unknown): JsonObject {
  if (!isPlainObject(config)) return {};
  if (readMcpGatewayMode(config) !== "transparent_proxy") {
    return deepClone(config);
  }
  const next = omitMcpGatewayAggregateOnlyFields(config);
  next.mode = "transparent_proxy";
  return next;
}

/**
 * Switch modes. Leaving aggregate mode always yields a (possibly empty)
 * stash, so returning restores exactly what was there; `null` means nothing
 * has been captured. An aggregate-only field typed while in transparent mode
 * is merged over the stash on return (a deep merge, so a typed
 * `policy.default_action` keeps the stashed `policy.tools`).
 */
export function switchMcpGatewayMode(
  config: unknown,
  nextMode: McpGatewayMode,
  stash: JsonObject | null = null,
): { config: JsonObject; stash: JsonObject | null } {
  const base = isPlainObject(config) ? deepClone(config) : {};
  if (nextMode === "transparent_proxy") {
    const nextStash = mergeDefined(stash ?? {}, pickMcpGatewayAggregateOnlyFields(base));
    const stripped = omitMcpGatewayAggregateOnlyFields(base);
    stripped.mode = "transparent_proxy";
    return { config: stripped, stash: nextStash };
  }
  const restoredStash =
    stash === null ? null : mergeDefined(stash, pickMcpGatewayAggregateOnlyFields(base));
  const restored = applyMcpGatewayAggregateDefaults(base, restoredStash);
  return { config: restored, stash: null };
}
