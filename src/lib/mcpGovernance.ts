/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – AI governance on an agent-facing MCP proxy        */
/*                                                                    */
/*  Ferrum Edge's recommended stack for an `mcp_gateway` endpoint      */
/*  (`docs/plugins.md`, "Recommended plugin stack for an agent-facing  */
/*  MCP endpoint", v0.9.9) puts four controls in front of the gateway: */
/*  `ai_transcript_audit`, a `rate_limiting` tool-call budget          */
/*  (`mcp_tool_calls`), `ai_prompt_shield` over `mcp_arguments`, and   */
/*  `ai_tool_governor` with `inspect.mcp_tool_calls`. This summary     */
/*  reads the proxy's effective plugins (the same scope merge the      */
/*  Plugins tab uses) and says which of them run, and whether each one */
/*  actually looks at MCP `tools/call` traffic.                        */
/* ------------------------------------------------------------------ */

import type { EffectivePlugin } from "./effectivePolicy";

export type McpGovernanceControlKey =
  | "ai_tool_governor"
  | "ai_prompt_shield"
  | "ai_transcript_audit"
  | "tool_call_limit";

export interface McpGovernanceInstance {
  plugin: EffectivePlugin;
  /** Whether this instance is configured to act on MCP `tools/call`. */
  mcpAware: boolean;
  /** A `trigger` limits it to matching requests. */
  conditional: boolean;
  /** Why it covers only part of the endpoint's tool calls, or `null`. */
  partial: string | null;
}

export interface McpGovernanceControl {
  key: McpGovernanceControlKey;
  label: string;
  /** What the control does on an MCP endpoint, in one sentence. */
  role: string;
  instances: McpGovernanceInstance[];
  /** Attached, but no instance looks at `tools/call`; the sentence says why. */
  gap: string | null;
  /**
   * Attached and MCP-aware, but together the instances cover only part of the
   * proxy's tool calls (a subset of tools, or not every endpoint).
   */
  partial: boolean;
  /** mcp_gateway endpoint paths no full-coverage instance counts. */
  uncovered: string[];
}

export interface McpGovernanceSummary {
  controls: McpGovernanceControl[];
  /** At least one control is attached. */
  governed: boolean;
  /** At least one attached control acts on MCP `tools/call`. */
  mcpGoverned: boolean;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function config(plugin: EffectivePlugin): JsonObject {
  return isPlainObject(plugin.config) ? plugin.config : {};
}

interface ControlDefinition {
  key: McpGovernanceControlKey;
  label: string;
  role: string;
  /** Which effective plugins count as an instance of this control. */
  matches: (plugin: EffectivePlugin) => boolean;
  /** `endpoints` are the proxy's mcp_gateway endpoint paths (empty when unknown). */
  mcpAware: (plugin: EffectivePlugin, endpoints: ReadonlySet<string>) => boolean;
  /** Why an aware instance covers only some tools, or `null`. */
  partial?: (plugin: EffectivePlugin) => string | null;
  /** The one endpoint path an instance is limited to, or `null` for every path. */
  covers?: (plugin: EffectivePlugin) => string | null;
  /** Why no instance acts on this proxy's tool calls. */
  gap: (plugins: readonly EffectivePlugin[], endpoints: ReadonlySet<string>) => string;
}

/** `rate_limiting`'s `mcp_tool_calls.endpoint_path`, or `null` when unset. */
function limitedPath(plugin: EffectivePlugin): string | null {
  const counted = config(plugin).mcp_tool_calls;
  const path = isPlainObject(counted) ? counted.endpoint_path : undefined;
  return typeof path === "string" ? path : null;
}

const CONTROLS: readonly ControlDefinition[] = [
  {
    key: "ai_tool_governor",
    label: "Tool governor",
    role: "Allow, deny, or approval policy on public tool names and arguments.",
    matches: (plugin) => plugin.plugin_name === "ai_tool_governor",
    // `inspect.mcp_tool_calls` defaults to false, and `enabled: false` makes
    // the plugin inert.
    mcpAware: (plugin) => {
      const settings = config(plugin);
      const inspect = settings.inspect;
      return (
        settings.enabled !== false && isPlainObject(inspect) && inspect.mcp_tool_calls === true
      );
    },
    gap: () =>
      "ai_tool_governor runs here but does not inspect MCP tools/call " +
      "(set inspect.mcp_tool_calls to true).",
  },
  {
    key: "ai_prompt_shield",
    label: "Prompt shield",
    role: "PII and secret screening of tool-call arguments.",
    matches: (plugin) => plugin.plugin_name === "ai_prompt_shield",
    // `mcp_arguments` scans `params.arguments`; `all` scans the whole body.
    // The default, `content`, scans only LLM prompt fields.
    mcpAware: (plugin) => {
      const fields = config(plugin).scan_fields;
      return fields === "mcp_arguments" || fields === "all";
    },
    gap: () =>
      "ai_prompt_shield runs here but scans only LLM prompt fields " +
      "(set scan_fields to mcp_arguments).",
  },
  {
    key: "ai_transcript_audit",
    label: "Transcript audit",
    role: "Records each tools/call with its consumer, tool, arguments hash, and outcome.",
    matches: (plugin) => plugin.plugin_name === "ai_transcript_audit",
    // `capture.mcp_tool_calls` defaults to true.
    mcpAware: (plugin) => {
      const capture = config(plugin).capture;
      return !(isPlainObject(capture) && capture.mcp_tool_calls === false);
    },
    gap: () =>
      "ai_transcript_audit runs here but does not capture MCP tools/call " +
      "(capture.mcp_tool_calls is false).",
  },
  {
    key: "tool_call_limit",
    label: "Tool-call limit",
    role: "Per-consumer budget charged for each tools/call (rate_limiting with mcp_tool_calls).",
    // Only a limiter that counts tool calls is a tool-call limit; an ordinary
    // request-rate limiter does not charge tools/call.
    matches: (plugin) =>
      plugin.plugin_name === "rate_limiting" && isPlainObject(config(plugin).mcp_tool_calls),
    // `mcp_tool_calls.endpoint_path` limits the limiter to one exact path
    // (unset inspects every path). Set to a path no mcp_gateway on this proxy
    // serves, it charges nothing here: a gap, not a partial limit.
    mcpAware: (plugin, endpoints) => {
      const path = limitedPath(plugin);
      return path === null || endpoints.size === 0 || endpoints.has(path);
    },
    // `tools` limits it to the named public tools.
    partial: (plugin) => {
      const tools = (config(plugin).mcp_tool_calls as JsonObject).tools;
      return Array.isArray(tools) && tools.length > 0
        ? `Partial: it counts only ${tools.length} named tool(s).`
        : null;
    },
    covers: limitedPath,
    gap: (plugins, endpoints) =>
      `rate_limiting counts tool calls only on ${plugins.map(limitedPath).join(", ")}, ` +
      `which is not this proxy's mcp_gateway endpoint (${[...endpoints].join(", ")}), ` +
      "so it charges no tool call here.",
  },
];

/** Which recommended MCP controls run on the proxy, from its effective plugins. */
export function summarizeMcpGovernance(plugins: readonly EffectivePlugin[]): McpGovernanceSummary {
  // The proxy's MCP endpoints, from its effective mcp_gateway instances.
  const endpoints = new Set(
    plugins
      .filter((plugin) => plugin.plugin_name === "mcp_gateway")
      .map((plugin) => config(plugin).endpoint)
      .map((endpoint) => (isPlainObject(endpoint) ? endpoint.path : undefined))
      .filter((path): path is string => typeof path === "string"),
  );
  const controls = CONTROLS.map((definition): McpGovernanceControl => {
    const instances = plugins.filter(definition.matches).map((plugin) => {
      const mcpAware = definition.mcpAware(plugin, endpoints);
      return {
        plugin,
        mcpAware,
        conditional: plugin.trigger != null,
        partial: mcpAware ? (definition.partial?.(plugin) ?? null) : null,
      };
    });
    const gap =
      instances.length > 0 && !instances.some((instance) => instance.mcpAware)
        ? definition.gap(instances.map((instance) => instance.plugin), endpoints)
        : null;
    const aware = instances.filter((instance) => instance.mcpAware);
    // Full coverage: aware instances with no subset, which between them count
    // every endpoint (one with no endpoint restriction counts all of them).
    const paths = aware
      .filter((instance) => instance.partial === null)
      .map((instance) => definition.covers?.(instance.plugin) ?? null);
    const uncovered =
      aware.length === 0 || paths.includes(null)
        ? []
        : endpoints.size === 0
          ? paths.length > 0
            ? []
            : ["the mcp_gateway endpoint"]
          : [...endpoints].filter((path) => !paths.includes(path));
    return {
      key: definition.key,
      label: definition.label,
      role: definition.role,
      instances,
      gap,
      partial: uncovered.length > 0,
      uncovered,
    };
  });
  return {
    controls,
    governed: controls.some((control) => control.instances.length > 0),
    mcpGoverned: controls.some((control) =>
      control.instances.some((instance) => instance.mcpAware),
    ),
  };
}

/** The warning for an agent-facing endpoint with no governance at all. */
export const UNGOVERNED_MCP_WARNING =
  "This agent-facing MCP endpoint has no AI governance: no tool governor, prompt shield, " +
  "transcript audit, or tool-call limit runs on this proxy. Agents can call every tool " +
  "this policy admits without screening, budget, or an audit record.";

/** The warning when controls are attached but none of them acts on MCP traffic. */
export const MCP_UNAWARE_GOVERNANCE_WARNING =
  "AI governance plugins run on this proxy, but none of them is configured for MCP " +
  "tools/call traffic, so tool calls pass unscreened, unbudgeted, and unaudited.";
