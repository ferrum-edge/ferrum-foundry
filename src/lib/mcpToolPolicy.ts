/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – per-tool policy in an mcp_gateway configuration   */
/*                                                                    */
/*  `config.policy.tools` maps a public, namespaced tool name to one   */
/*  closed entry: an action, and for `allow` an optional per-consumer  */
/*  grant (`allowed_groups` / `denied_groups`, matched against the     */
/*  request Consumer's `acl_groups`). Ferrum Edge v0.9.9               */
/*  (`McpGatewayConfig` in `openapi.yaml`) checks the shape with JSON  */
/*  Schema and the cross-value rules at plugin load; this module       */
/*  mirrors both, so the inline editor refuses what Edge would refuse  */
/*  before anything is sent. Edits are lossless: every other key of    */
/*  the configuration, and the position of an existing entry, is kept. */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

export type McpToolAction = "allow" | "deny" | "hide_from_discovery";

export const MCP_TOOL_ACTIONS: readonly McpToolAction[] = [
  "allow",
  "deny",
  "hide_from_discovery",
];

export const MCP_TOOL_ACTION_LABELS: Record<McpToolAction, string> = {
  allow: "Allow",
  deny: "Deny",
  hide_from_discovery: "Hide from discovery",
};

/** One `policy.tools` entry. Groups are only meaningful with `allow`. */
export interface McpToolPolicyEntry {
  action: McpToolAction;
  allowed_groups?: string[] | null;
  denied_groups?: string[] | null;
}

/** Edge's per-list bound, and its bound on distinct groups across the map. */
export const MAX_TOOL_GRANT_GROUPS = 512;
/** Edge enforces the 255-byte group bound at plugin load (UTF-8 bytes). */
export const MAX_TOOL_GRANT_GROUP_BYTES = 255;

// The schema's `pattern` and `not.pattern`, as code points rather than regular
// expressions so no control character appears in a pattern literal.
function isSchemaWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Control characters other than tab, LF, and CR. */
function isForbiddenControl(code: number): boolean {
  return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is McpToolAction {
  return value === "allow" || value === "deny" || value === "hide_from_discovery";
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `config.mode`, or `null` when it is missing or not a string. */
export function mcpGatewayMode(config: unknown): string | null {
  return isPlainObject(config) && typeof config.mode === "string" ? config.mode : null;
}

/** `discovery.namespace_separator`, defaulting to `.` as Edge does. */
export function namespaceSeparator(config: unknown): string {
  const discovery = isPlainObject(config) ? config.discovery : undefined;
  const separator = isPlainObject(discovery) ? discovery.namespace_separator : undefined;
  return typeof separator === "string" && separator.length > 0 ? separator : ".";
}

/** Every configured server's public `namespace`, enabled or not. */
export function serverNamespaces(config: unknown): string[] {
  const servers = isPlainObject(config) ? config.servers : undefined;
  if (!isPlainObject(servers)) return [];
  return Object.values(servers)
    .map((server) => (isPlainObject(server) ? server.namespace : undefined))
    .filter((namespace): namespace is string => typeof namespace === "string");
}

/** `policy.default_action`; omitted or `null` selects Edge's default, `deny`. */
export function defaultToolAction(config: unknown): "allow" | "deny" {
  const policy = isPlainObject(config) ? config.policy : undefined;
  return isPlainObject(policy) && policy.default_action === "allow" ? "allow" : "deny";
}

/**
 * Whether a tool with no `policy.tools` entry stays hidden: Edge v0.9.9
 * (`mcp_gateway.rs`, catalog construction) hides a tool new to a session's
 * catalog while `discovery.on_new_tool` is `hide_until_configured`, its
 * default, until `policy.tools` names it. `allow`, `allow_immediately`, and
 * `expose` let it through to `default_action`.
 */
export function hidesUnconfiguredTools(config: unknown): boolean {
  const discovery = isPlainObject(config) ? config.discovery : undefined;
  const onNewTool = isPlainObject(discovery) ? discovery.on_new_tool : undefined;
  return onNewTool === undefined || onNewTool === null || onNewTool === "hide_until_configured";
}

/** What removing an entry leaves the tool with, in words. */
export function unconfiguredToolSummary(config: unknown): string {
  return hidesUnconfiguredTools(config)
    ? "No entry (hidden until configured)"
    : `No entry (default: ${MCP_TOOL_ACTION_LABELS[defaultToolAction(config)]})`;
}

/** The `policy.tools` map, or an empty map when there is none. */
export function configuredToolPolicies(config: unknown): JsonObject {
  const policy = isPlainObject(config) ? config.policy : undefined;
  const tools = isPlainObject(policy) ? policy.tools : undefined;
  return isPlainObject(tools) ? tools : {};
}

/** The stored entry for `name` exactly as configured, or `undefined`. */
export function rawToolPolicy(config: unknown, name: string): unknown {
  const tools = configuredToolPolicies(config);
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * A stored entry as an editable value, or `null` when it is absent or has a
 * shape Edge would not have admitted (the raw value is still shown).
 */
export function parseToolPolicy(raw: unknown): McpToolPolicyEntry | null {
  if (!isPlainObject(raw) || !isAction(raw.action)) return null;
  return {
    action: raw.action,
    allowed_groups: stringList(raw.allowed_groups),
    denied_groups: stringList(raw.denied_groups),
  };
}

/** The entry as it is written: groups only with `allow`, and never empty. */
export function normalizeToolPolicy(entry: McpToolPolicyEntry): JsonObject {
  const written: JsonObject = { action: entry.action };
  if (entry.action !== "allow") return written;
  if (entry.allowed_groups && entry.allowed_groups.length > 0) {
    written.allowed_groups = [...entry.allowed_groups];
  }
  if (entry.denied_groups && entry.denied_groups.length > 0) {
    written.denied_groups = [...entry.denied_groups];
  }
  return written;
}

/** Whether an entry carries a per-consumer grant. */
export function isGroupConditioned(entry: McpToolPolicyEntry | null): boolean {
  if (!entry || entry.action !== "allow") return false;
  return (entry.allowed_groups?.length ?? 0) > 0 || (entry.denied_groups?.length ?? 0) > 0;
}

/** Why one group name would be refused, or `null`. */
export function groupProblem(group: string): string | null {
  if (group.length === 0) return "a group name cannot be empty";
  const codes = [...group].map((character) => character.codePointAt(0) ?? 0);
  if (codes.every(isSchemaWhitespace)) return `"${group}" has no non-whitespace character`;
  if (codes.some(isForbiddenControl)) return "a group name contains a control character";
  if (new TextEncoder().encode(group).length > MAX_TOOL_GRANT_GROUP_BYTES) {
    return `"${group}" is longer than ${MAX_TOOL_GRANT_GROUP_BYTES} bytes`;
  }
  return null;
}

/**
 * Everything Edge would refuse about writing `entry` for `name` into
 * `config`, as sentences. Empty when the write is admissible. `entry: null`
 * (remove the entry, so `default_action` applies) is checked only for the
 * catalog mode.
 */
export function validateToolPolicy(
  config: unknown,
  name: string,
  entry: McpToolPolicyEntry | null,
): string[] {
  const problems: string[] = [];
  if (mcpGatewayMode(config) !== "aggregate_router") {
    problems.push(
      "Tool policy needs mode aggregate_router; a transparent_proxy instance has no catalog " +
        "and Ferrum Edge rejects policy.tools there.",
    );
  }
  if (name.length === 0) problems.push("Enter the tool's public name.");
  if (!entry) return problems;
  if (!isAction(entry.action)) {
    problems.push("Choose allow, deny, or hide from discovery.");
    return problems;
  }

  const allowed = entry.allowed_groups ?? [];
  const denied = entry.denied_groups ?? [];
  if (entry.action !== "allow" && (allowed.length > 0 || denied.length > 0)) {
    problems.push("Groups apply only to an allow entry.");
  }
  for (const [label, list] of [
    ["Allowed groups", allowed],
    ["Denied groups", denied],
  ] as const) {
    if (list.length > MAX_TOOL_GRANT_GROUPS) {
      problems.push(`${label} can name at most ${MAX_TOOL_GRANT_GROUPS} groups.`);
    }
    for (const group of list) {
      const problem = groupProblem(group);
      if (problem) problems.push(`${label}: ${problem}.`);
    }
  }
  const both = allowed.filter((group) => denied.includes(group));
  if (both.length > 0) {
    problems.push(`A group cannot be both allowed and denied: ${both.join(", ")}.`);
  }

  if (isGroupConditioned(entry)) {
    const separator = namespaceSeparator(config);
    const owner = serverNamespaces(config).find(
      (namespace) =>
        name.startsWith(`${namespace}${separator}`) &&
        name.length > namespace.length + separator.length,
    );
    if (!owner) {
      problems.push(
        `A group-conditioned tool must be named <server namespace>${separator}<tool>, ` +
          "for a server this configuration defines.",
      );
    }
    const groups = new Set<string>();
    const tools = { ...configuredToolPolicies(config), [name]: normalizeToolPolicy(entry) };
    for (const value of Object.values(tools)) {
      const parsed = parseToolPolicy(value);
      for (const group of [...(parsed?.allowed_groups ?? []), ...(parsed?.denied_groups ?? [])]) {
        groups.add(group);
      }
    }
    if (groups.size > MAX_TOOL_GRANT_GROUPS) {
      problems.push(
        `policy.tools would reference ${groups.size} distinct groups; Ferrum Edge allows ` +
          `${MAX_TOOL_GRANT_GROUPS}.`,
      );
    }
  }
  return problems;
}

/**
 * A copy of `config` with `name`'s entry set to `entry`, or removed for
 * `null`. Nothing else changes: an existing entry keeps its position in the
 * map, and a configuration with no `policy` gains only `policy.tools`.
 */
export function withToolPolicy(
  config: Record<string, unknown>,
  name: string,
  entry: McpToolPolicyEntry | null,
): Record<string, unknown> {
  const next = deepClone(config);
  const policy = isPlainObject(next.policy) ? next.policy : null;
  const tools = policy && isPlainObject(policy.tools) ? policy.tools : null;
  if (!entry) {
    if (tools) delete tools[name];
    return next;
  }
  const written = normalizeToolPolicy(entry);
  if (tools) {
    tools[name] = written;
  } else if (policy) {
    policy.tools = { [name]: written };
  } else {
    next.policy = { tools: { [name]: written } };
  }
  return next;
}
