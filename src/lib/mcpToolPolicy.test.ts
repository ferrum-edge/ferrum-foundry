import { describe, expect, it } from "vitest";
import {
  configuredToolPolicies,
  hidesUnconfiguredTools,
  unconfiguredToolSummary,
  defaultToolAction,
  groupProblem,
  isGroupConditioned,
  namespaceSeparator,
  normalizeToolPolicy,
  parseToolPolicy,
  validateToolPolicy,
  withToolPolicy,
} from "./mcpToolPolicy";

function gateway(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "aggregate_router",
    endpoint: { path: "/mcp" },
    servers: {
      github: { upstream_url: "https://mcp.example.com/mcp", namespace: "github" },
      orders: { namespace: "orders", openapi: { operations: [] } },
    },
    policy: {
      default_action: "deny",
      tools: {
        "github.search_issues": { action: "allow" },
        "orders.list_orders": { action: "allow", allowed_groups: ["support"] },
      },
    },
    ...overrides,
  };
}

describe("reading policy.tools", () => {
  it("reads the map, the default action, and the separator with Edge's defaults", () => {
    expect(Object.keys(configuredToolPolicies(gateway()))).toEqual([
      "github.search_issues",
      "orders.list_orders",
    ]);
    expect(configuredToolPolicies({ policy: null })).toEqual({});
    expect(defaultToolAction(gateway())).toBe("deny");
    expect(defaultToolAction({})).toBe("deny");
    expect(defaultToolAction({ policy: { default_action: "allow" } })).toBe("allow");
    expect(namespaceSeparator({})).toBe(".");
    expect(namespaceSeparator({ discovery: { namespace_separator: "__" } })).toBe("__");
  });

  it("parses an entry only when Edge would have admitted its action", () => {
    expect(parseToolPolicy({ action: "allow", allowed_groups: ["a"] })).toEqual({
      action: "allow",
      allowed_groups: ["a"],
      denied_groups: null,
    });
    expect(parseToolPolicy({ action: "maybe" })).toBeNull();
    expect(parseToolPolicy("allow")).toBeNull();
    expect(parseToolPolicy(undefined)).toBeNull();
  });

  it("knows a grant from a plain action", () => {
    expect(isGroupConditioned({ action: "allow", allowed_groups: ["a"] })).toBe(true);
    expect(isGroupConditioned({ action: "allow", denied_groups: ["a"] })).toBe(true);
    expect(isGroupConditioned({ action: "allow", allowed_groups: [] })).toBe(false);
    expect(isGroupConditioned({ action: "deny" })).toBe(false);
    expect(isGroupConditioned(null)).toBe(false);
  });
});

describe("writing one entry", () => {
  it("replaces an entry in place and leaves every other key alone", () => {
    const config = gateway({ validation: { validate_tool_arguments: true } });
    const next = withToolPolicy(config, "github.search_issues", {
      action: "allow",
      allowed_groups: ["eng"],
      denied_groups: ["contractors"],
    });
    expect(Object.keys(configuredToolPolicies(next))).toEqual([
      "github.search_issues",
      "orders.list_orders",
    ]);
    expect(configuredToolPolicies(next)["github.search_issues"]).toEqual({
      action: "allow",
      allowed_groups: ["eng"],
      denied_groups: ["contractors"],
    });
    expect(next.validation).toEqual({ validate_tool_arguments: true });
    expect(next.servers).toEqual(config.servers);
    // The input is not mutated.
    expect(configuredToolPolicies(config)["github.search_issues"]).toEqual({ action: "allow" });
  });

  it("appends a new entry and creates policy.tools when there is none", () => {
    const appended = withToolPolicy(gateway(), "github.create_issue", { action: "deny" });
    expect(Object.keys(configuredToolPolicies(appended))).toEqual([
      "github.search_issues",
      "orders.list_orders",
      "github.create_issue",
    ]);
    const bare = withToolPolicy({ mode: "aggregate_router" }, "a.b", { action: "allow" });
    expect(bare.policy).toEqual({ tools: { "a.b": { action: "allow" } } });
    const withDefault = withToolPolicy(
      { mode: "aggregate_router", policy: { default_action: "allow" } },
      "a.b",
      { action: "deny" },
    );
    expect(withDefault.policy).toEqual({ default_action: "allow", tools: { "a.b": { action: "deny" } } });
  });

  it("removes an entry so the default action applies", () => {
    const next = withToolPolicy(gateway(), "orders.list_orders", null);
    expect(Object.keys(configuredToolPolicies(next))).toEqual(["github.search_issues"]);
    expect(withToolPolicy({ mode: "aggregate_router" }, "a.b", null)).toEqual({ mode: "aggregate_router" });
  });

  it("never writes empty or non-allow group lists", () => {
    expect(normalizeToolPolicy({ action: "allow", allowed_groups: [], denied_groups: [] })).toEqual({
      action: "allow",
    });
    expect(normalizeToolPolicy({ action: "deny", allowed_groups: ["eng"] })).toEqual({ action: "deny" });
  });
});

describe("validation mirrors Edge", () => {
  it("admits ordinary entries", () => {
    expect(validateToolPolicy(gateway(), "github.search_issues", { action: "deny" })).toEqual([]);
    expect(
      validateToolPolicy(gateway(), "github.search_issues", {
        action: "allow",
        allowed_groups: ["eng"],
        denied_groups: ["contractors"],
      }),
    ).toEqual([]);
    expect(validateToolPolicy(gateway(), "github.search_issues", null)).toEqual([]);
  });

  it("refuses tool policy outside aggregate_router", () => {
    const problems = validateToolPolicy({ mode: "transparent_proxy" }, "a.b", { action: "allow" });
    expect(problems.join(" ")).toContain("aggregate_router");
  });

  it("refuses groups on deny and hide, and a group in both lists", () => {
    expect(
      validateToolPolicy(gateway(), "github.search_issues", {
        action: "deny",
        allowed_groups: ["eng"],
      }).join(" "),
    ).toContain("only to an allow entry");
    expect(
      validateToolPolicy(gateway(), "github.search_issues", {
        action: "allow",
        allowed_groups: ["eng", "ops"],
        denied_groups: ["ops"],
      }).join(" "),
    ).toContain("both allowed and denied: ops");
  });

  it("refuses a grant on a name no configured server namespace owns", () => {
    expect(
      validateToolPolicy(gateway(), "jira.search", { action: "allow", allowed_groups: ["eng"] }).join(" "),
    ).toContain("<server namespace>.<tool>");
    expect(
      validateToolPolicy(gateway(), "github.", { action: "allow", allowed_groups: ["eng"] }).length,
    ).toBe(1);
    // A plain action has no such requirement.
    expect(validateToolPolicy(gateway(), "jira.search", { action: "allow" })).toEqual([]);
  });

  it("checks group names as Edge does", () => {
    expect(groupProblem("eng")).toBeNull();
    expect(groupProblem(" eng ")).toBeNull();
    expect(groupProblem("")).not.toBeNull();
    expect(groupProblem("   ")).toContain("no non-whitespace");
    expect(groupProblem("a\u0001b")).toContain("control character");
    expect(groupProblem("tab\there")).toBeNull();
    expect(groupProblem("x".repeat(255))).toBeNull();
    expect(groupProblem("é".repeat(128))).toContain("255 bytes");
  });

  it("caps distinct groups across the whole map", () => {
    const groups = Array.from({ length: 512 }, (_, index) => `g${index}`);
    const config = gateway({
      policy: { tools: { "github.a": { action: "allow", allowed_groups: groups } } },
    });
    expect(
      validateToolPolicy(config, "github.b", { action: "allow", allowed_groups: ["g0"] }),
    ).toEqual([]);
    expect(
      validateToolPolicy(config, "github.b", { action: "allow", allowed_groups: ["extra"] }).join(" "),
    ).toContain("513 distinct groups");
  });
});

describe("a tool with no entry", () => {
  it("stays hidden under Edge's default discovery.on_new_tool", () => {
    expect(hidesUnconfiguredTools({})).toBe(true);
    expect(hidesUnconfiguredTools({ discovery: null })).toBe(true);
    expect(hidesUnconfiguredTools({ discovery: { on_new_tool: null } })).toBe(true);
    expect(hidesUnconfiguredTools({ discovery: { on_new_tool: "hide_until_configured" } })).toBe(true);
    expect(unconfiguredToolSummary(gateway())).toBe("No entry (hidden until configured)");
  });

  it("gets the default action when new tools are let through", () => {
    for (const onNewTool of ["allow", "allow_immediately", "expose"]) {
      expect(hidesUnconfiguredTools({ discovery: { on_new_tool: onNewTool } })).toBe(false);
    }
    expect(unconfiguredToolSummary(gateway({ discovery: { on_new_tool: "allow" } })))
      .toBe("No entry (default: Deny)");
    expect(unconfiguredToolSummary({
      discovery: { on_new_tool: "expose" },
      policy: { default_action: "allow" },
    })).toBe("No entry (default: Allow)");
  });
});
