type JsonObject = { [key: string]: unknown };

export type McpGatewayMode = "aggregate_router" | "transparent_proxy";

/** Keys rejected by the gateway for `mode: transparent_proxy` (presence-based). */
export const MCP_GATEWAY_AGGREGATE_ONLY_PATHS = [
  "policy.default_action",
  "policy.tools",
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
  discovery: {
    public_base_url: "https://mcp.example.com",
  },
};

const SHARED_TEMPLATE: JsonObject = {
  endpoint: {
    path: "/mcp",
    protocol_versions: ["2025-11-25"],
  },
  servers: {
    github: {
      upstream_url: "https://mcp-github.internal.example.com/mcp",
      namespace: "github",
      expose_tools: true,
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

export function applyMcpGatewayAggregateDefaults(
  config: unknown,
  stash: JsonObject = {},
): JsonObject {
  const next = isPlainObject(config) ? deepClone(config) : {};
  next.mode = "aggregate_router";
  const restored = mergeDefined(AGGREGATE_FIELD_DEFAULTS, stash);
  return mergeDefined(next, restored);
}

export function buildMcpGatewayTemplate(mode: McpGatewayMode): JsonObject {
  if (mode === "transparent_proxy") {
    return {
      mode: "transparent_proxy",
      ...deepClone(SHARED_TEMPLATE),
    };
  }
  return applyMcpGatewayAggregateDefaults({
    mode: "aggregate_router",
    ...deepClone(SHARED_TEMPLATE),
  });
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

export function switchMcpGatewayMode(
  config: unknown,
  nextMode: McpGatewayMode,
  stash: JsonObject = {},
): { config: JsonObject; stash: JsonObject } {
  const base = isPlainObject(config) ? deepClone(config) : {};
  if (nextMode === "transparent_proxy") {
    const nextStash = mergeDefined(stash, pickMcpGatewayAggregateOnlyFields(base));
    const stripped = omitMcpGatewayAggregateOnlyFields(base);
    stripped.mode = "transparent_proxy";
    return { config: stripped, stash: nextStash };
  }
  const restored = applyMcpGatewayAggregateDefaults(base, stash);
  return { config: restored, stash: {} };
}
