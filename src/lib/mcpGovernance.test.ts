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

  it("marks a tool-call limit partial when it names a subset of tools", () => {
    const gateway = plugin("mcp_gateway", { mode: "aggregate_router", endpoint: { path: "/mcp" } });
    const limit = (counted: Record<string, unknown>) =>
      plugin("rate_limiting", { limit_by: "consumer", mcp_tool_calls: counted });

    const full = summarizeMcpGovernance([gateway, limit({ endpoint_path: "/mcp" })]);
    expect(control(full, "tool_call_limit").partial).toBe(false);
    expect(control(full, "tool_call_limit").instances[0].partial).toBeNull();
    // An unset endpoint_path inspects every path.
    expect(control(summarizeMcpGovernance([gateway, limit({})]), "tool_call_limit").partial)
      .toBe(false);

    const subset = summarizeMcpGovernance([
      gateway,
      limit({ endpoint_path: "/mcp", tools: ["github.search"], per_tool: true }),
    ]);
    expect(control(subset, "tool_call_limit").partial).toBe(true);
    expect(control(subset, "tool_call_limit").uncovered).toEqual(["/mcp"]);
    expect(control(subset, "tool_call_limit").instances[0].partial).toContain("1 named tool(s)");
    // A partial limit still governs the calls it counts.
    expect(subset.mcpGoverned).toBe(true);
  });

  it("treats a limit on a path no mcp_gateway serves as a gap, not partial coverage", () => {
    const gateway = plugin("mcp_gateway", { mode: "aggregate_router", endpoint: { path: "/mcp" } });
    const limit = (counted: Record<string, unknown>, id = "rate_limiting-1") =>
      plugin("rate_limiting", { limit_by: "consumer", mcp_tool_calls: counted }, { id });

    // Edge counts zero tool calls there.
    const elsewhere = summarizeMcpGovernance([gateway, limit({ endpoint_path: "/agents" })]);
    const limitControl = control(elsewhere, "tool_call_limit");
    expect(limitControl.instances[0].mcpAware).toBe(false);
    expect(limitControl.partial).toBe(false);
    expect(limitControl.gap).toContain("only on /agents");
    expect(limitControl.gap).toContain("(/mcp)");
    // It is the only control, so nothing on the proxy governs MCP tool calls.
    expect(elsewhere.governed).toBe(true);
    expect(elsewhere.mcpGoverned).toBe(false);

    // One limit on the endpoint beside one elsewhere covers the endpoint.
    const mixed = summarizeMcpGovernance([
      gateway,
      limit({ endpoint_path: "/agents" }),
      limit({ endpoint_path: "/mcp" }, "rate_limiting-2"),
    ]);
    expect(control(mixed, "tool_call_limit").gap).toBeNull();
    expect(control(mixed, "tool_call_limit").partial).toBe(false);
  });

  it("requires every mcp_gateway endpoint to be counted for full coverage", () => {
    const gateways = [
      plugin("mcp_gateway", { endpoint: { path: "/mcp" } }, { id: "mcp-a" }),
      plugin("mcp_gateway", { endpoint: { path: "/tools" } }, { id: "mcp-b" }),
    ];
    const limit = (counted: Record<string, unknown>, id = "rate_limiting-1") =>
      plugin("rate_limiting", { limit_by: "consumer", mcp_tool_calls: counted }, { id });

    const one = summarizeMcpGovernance([...gateways, limit({ endpoint_path: "/mcp" })]);
    expect(control(one, "tool_call_limit").partial).toBe(true);
    expect(control(one, "tool_call_limit").uncovered).toEqual(["/tools"]);
    expect(control(one, "tool_call_limit").gap).toBeNull();

    const both = summarizeMcpGovernance([
      ...gateways,
      limit({ endpoint_path: "/mcp" }),
      limit({ endpoint_path: "/tools" }, "rate_limiting-2"),
    ]);
    expect(control(both, "tool_call_limit").partial).toBe(false);

    // A subset limit on the second endpoint does not complete the coverage.
    const subsetSecond = summarizeMcpGovernance([
      ...gateways,
      limit({ endpoint_path: "/mcp" }),
      limit({ endpoint_path: "/tools", tools: ["a.b"] }, "rate_limiting-2"),
    ]);
    expect(control(subsetSecond, "tool_call_limit").uncovered).toEqual(["/tools"]);

    const everywhere = summarizeMcpGovernance([...gateways, limit({})]);
    expect(control(everywhere, "tool_call_limit").partial).toBe(false);
  });
});
