import { describe, expect, it } from "vitest";
import type { EffectivePlugin } from "./effectivePolicy";
import { summarizeMcpGovernance } from "./mcpGovernance";

function plugin(
  plugin_name: string,
  config: Record<string, unknown> = {},
  overrides: Partial<EffectivePlugin> = {},
): EffectivePlugin {
  return {
    id: `${plugin_name}-1`,
    plugin_name,
    config,
    scope: "proxy",
    proxy_id: "agents",
    enabled: true,
    created_at: "2026-09-30T12:00:00Z",
    updated_at: "2026-09-30T12:00:00Z",
    effectiveSource: "proxy",
    ...overrides,
  };
}

function control(summary: ReturnType<typeof summarizeMcpGovernance>, key: string) {
  const found = summary.controls.find((entry) => entry.key === key);
  expect(found).toBeDefined();
  return found!;
}

describe("MCP governance summary", () => {
  it("reports an ungoverned endpoint", () => {
    const summary = summarizeMcpGovernance([plugin("key_auth"), plugin("mcp_gateway")]);
    expect(summary.governed).toBe(false);
    expect(summary.mcpGoverned).toBe(false);
    expect(summary.controls.map((entry) => entry.key)).toEqual([
      "ai_tool_governor",
      "ai_prompt_shield",
      "ai_transcript_audit",
      "tool_call_limit",
    ]);
    expect(summary.controls.every((entry) => entry.instances.length === 0)).toBe(true);
  });

  it("recognizes the recommended stack as MCP-aware", () => {
    const summary = summarizeMcpGovernance([
      plugin("ai_tool_governor", { inspect: { mcp_tool_calls: true } }),
      plugin("ai_prompt_shield", { scan_fields: "mcp_arguments" }),
      plugin("ai_transcript_audit", { capture: { mcp_tool_calls: true } }),
      plugin("rate_limiting", { mcp_tool_calls: { endpoint_path: "/mcp" } }),
    ]);
    expect(summary.governed).toBe(true);
    expect(summary.mcpGoverned).toBe(true);
    expect(summary.controls.every((entry) => entry.instances.length === 1 && entry.gap === null)).toBe(true);
  });

  it("says when an attached control does not look at tools/call", () => {
    const summary = summarizeMcpGovernance([
      plugin("ai_tool_governor", {}),
      plugin("ai_prompt_shield", { scan_fields: "content" }),
      plugin("ai_transcript_audit", { capture: { mcp_tool_calls: false } }),
    ]);
    expect(summary.governed).toBe(true);
    expect(summary.mcpGoverned).toBe(false);
    expect(control(summary, "ai_tool_governor").gap).toContain("inspect.mcp_tool_calls");
    expect(control(summary, "ai_prompt_shield").gap).toContain("scan_fields");
    expect(control(summary, "ai_transcript_audit").gap).toContain("capture.mcp_tool_calls");
  });

  it("treats a disabled governor as inert and audit capture as on by default", () => {
    const summary = summarizeMcpGovernance([
      plugin("ai_tool_governor", { enabled: false, inspect: { mcp_tool_calls: true } }),
      plugin("ai_transcript_audit", {}),
    ]);
    expect(control(summary, "ai_tool_governor").instances[0].mcpAware).toBe(false);
    expect(control(summary, "ai_transcript_audit").instances[0].mcpAware).toBe(true);
    expect(summary.mcpGoverned).toBe(true);
  });

  it("counts only a rate limiter that charges tool calls, and flags conditional triggers", () => {
    const summary = summarizeMcpGovernance([
      plugin("rate_limiting", { limit_by: "consumer" }),
      plugin("ai_prompt_shield", { scan_fields: "all" }, { trigger: { when: { match: {} } } }),
    ]);
    expect(control(summary, "tool_call_limit").instances).toHaveLength(0);
    const shield = control(summary, "ai_prompt_shield").instances[0];
    expect(shield.mcpAware).toBe(true);
    expect(shield.conditional).toBe(true);
  });
});
