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
}

export interface McpGovernanceControl {
  key: McpGovernanceControlKey;
  label: string;
  /** What the control does on an MCP endpoint, in one sentence. */
  role: string;
  instances: McpGovernanceInstance[];
  /** Attached, but no instance looks at `tools/call`; the sentence says why. */
  gap: string | null;
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
  mcpAware: (plugin: EffectivePlugin) => boolean;
  gap: string;
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
      return settings.enabled !== false && isPlainObject(inspect) && inspect.mcp_tool_calls === true;
    },
    gap: "ai_tool_governor runs here but does not inspect MCP tools/call (set inspect.mcp_tool_calls to true).",
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
    gap: "ai_prompt_shield runs here but scans only LLM prompt fields (set scan_fields to mcp_arguments).",
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
    gap: "ai_transcript_audit runs here but does not capture MCP tools/call (capture.mcp_tool_calls is false).",
  },
  {
    key: "tool_call_limit",
    label: "Tool-call limit",
    role: "Per-consumer budget charged for each tools/call (rate_limiting with mcp_tool_calls).",
    // Only a limiter that counts tool calls is a tool-call limit; an ordinary
    // request-rate limiter does not charge tools/call.
    matches: (plugin) =>
      plugin.plugin_name === "rate_limiting" && isPlainObject(config(plugin).mcp_tool_calls),
    mcpAware: () => true,
    gap: "",
  },
];

/** Which recommended MCP controls run on the proxy, from its effective plugins. */
export function summarizeMcpGovernance(plugins: readonly EffectivePlugin[]): McpGovernanceSummary {
  const controls = CONTROLS.map((definition): McpGovernanceControl => {
    const instances = plugins.filter(definition.matches).map((plugin) => ({
      plugin,
      mcpAware: definition.mcpAware(plugin),
      conditional: plugin.trigger != null,
    }));
    const gap =
      instances.length > 0 && !instances.some((instance) => instance.mcpAware)
        ? definition.gap
        : null;
    return {
      key: definition.key,
      label: definition.label,
      role: definition.role,
      instances,
      gap,
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
