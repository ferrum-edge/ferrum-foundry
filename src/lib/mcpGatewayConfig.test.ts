import { describe, expect, it } from "vitest";
import { getPluginConfigDefault } from "./pluginConfigDefaults";
import {
  MCP_GATEWAY_AGGREGATE_ONLY_PATHS,
  buildMcpGatewayTemplate,
  mcpGatewayConfigHasAggregateOnlyFields,
  omitMcpGatewayAggregateOnlyFields,
  sanitizeMcpGatewayConfigForSubmit,
  switchMcpGatewayMode,
} from "./mcpGatewayConfig";

const aggregateConfig = {
  mode: "aggregate_router",
  endpoint: { path: "/custom-mcp", protocol_versions: ["2025-11-25"] },
  servers: {
    github: {
      upstream_url: "https://mcp-github.internal.example.com/mcp",
      namespace: "github",
      expose_tools: true,
    },
  },
  discovery: {
    public_base_url: "https://mcp.example.com",
    aggregate_tools: true,
  },
  policy: {
    default_action: "deny",
    tools: {
      "github.search_issues": { action: "allow" },
    },
    hide_denied_tools: true,
  },
};

describe("mcpGatewayConfig", () => {
  it("keeps the aggregate palette default with discovery.public_base_url", () => {
    expect(getPluginConfigDefault("mcp_gateway")).toEqual({
      mode: "aggregate_router",
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
      discovery: {
        public_base_url: "https://mcp.example.com",
      },
      policy: {
        default_action: "deny",
        tools: {
          "github.search_issues": { action: "allow" },
        },
      },
    });
  });

  it("builds a transparent template without aggregate-only keys", () => {
    const template = buildMcpGatewayTemplate("transparent_proxy");
    expect(template.mode).toBe("transparent_proxy");
    expect(template.policy).toBeUndefined();
    expect(template.discovery).toBeUndefined();
    for (const path of MCP_GATEWAY_AGGREGATE_ONLY_PATHS) {
      const [section, field] = path.split(".");
      expect((template as Record<string, Record<string, unknown>>)[section]?.[field]).toBeUndefined();
    }
  });

  it("strips rejected keys from transparent-mode submissions", () => {
    const submitted = sanitizeMcpGatewayConfigForSubmit({
      mode: "transparent_proxy",
      endpoint: { path: "/mcp", protocol_versions: ["2025-11-25"] },
      policy: {
        default_action: "deny",
        tools: { "github.search_issues": { action: "allow" } },
      },
      discovery: {
        aggregate_tools: true,
        public_base_url: "https://mcp.example.com",
      },
    });

    expect(submitted.mode).toBe("transparent_proxy");
    expect(submitted.policy).toBeUndefined();
    expect(submitted.discovery).toEqual({
      public_base_url: "https://mcp.example.com",
    });
    expect(mcpGatewayConfigHasAggregateOnlyFields(submitted)).toBe(false);
  });

  it("leaves aggregate-mode submissions unchanged", () => {
    const submitted = sanitizeMcpGatewayConfigForSubmit(aggregateConfig);
    expect(submitted).toEqual(aggregateConfig);
  });

  it("switches modes without clobbering unrelated operator edits", () => {
    const customized = {
      ...aggregateConfig,
      endpoint: { path: "/operator-mcp", protocol_versions: ["2025-11-25"] },
      policy: {
        default_action: "allow",
        tools: {
          "github.search_issues": { action: "allow" },
          "github.create_issue": { action: "deny" },
        },
      },
    };

    const transparent = switchMcpGatewayMode(customized, "transparent_proxy");
    expect(transparent.config.endpoint).toEqual({
      path: "/operator-mcp",
      protocol_versions: ["2025-11-25"],
    });
    expect(transparent.config.policy).toBeUndefined();
    expect(transparent.config.discovery).toEqual({
      public_base_url: "https://mcp.example.com",
    });
    expect(transparent.stash.policy).toEqual(customized.policy);

    const restored = switchMcpGatewayMode(
      transparent.config,
      "aggregate_router",
      transparent.stash,
    );
    expect(restored.config.endpoint).toEqual(customized.endpoint);
    expect(restored.config.policy).toEqual(customized.policy);
    expect(restored.config.discovery).toEqual(customized.discovery);
    // Stripping the aggregate-only keys again leaves exactly the operator's
    // shared edits: `discovery.aggregate_tools` is itself aggregate-only.
    expect(omitMcpGatewayAggregateOnlyFields(restored.config)).toEqual({
      mode: "aggregate_router",
      endpoint: customized.endpoint,
      servers: customized.servers,
      discovery: { public_base_url: "https://mcp.example.com" },
    });
  });
});
