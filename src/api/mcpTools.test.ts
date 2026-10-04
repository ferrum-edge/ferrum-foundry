import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardVerificationError, isStaleResourceError } from "./conditionalWrite";
import { resetGatewayMetadata } from "./gatewayMetadata";
import { MaskedSecretWriteError } from "./maskedSecrets";
import {
  getToolCatalog,
  maskedToolPolicyAdvice,
  McpCatalogChangedError,
  McpToolPolicyError,
  newToolPolicyWriteGuard,
  toolPolicyWriteGuard,
  updateToolPolicy,
  type McpToolCatalogResponse,
  type McpToolCatalogTool,
} from "./mcpTools";
import type { PluginConfig } from "./types";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

const scope = { namespace: "tenant-a" };

function catalogTool(index: number): McpToolCatalogTool {
  return {
    name: `github.tool_${String(index).padStart(4, "0")}`,
    plugin_config_id: "mcp",
    title: null,
    description: null,
    annotations: null,
    source: { type: "upstream", server_id: "github", namespace: "github", upstream_name: `tool_${index}` },
    policy: { action: "allow", configured: true, effective: "allow", listed: true, callable: true },
    allowed_groups: null,
    denied_groups: [],
    schema_hash: "0".repeat(64),
    discovered_at: "2026-09-30T12:00:00Z",
  };
}

function catalogPage(
  total: number,
  offset: number,
  limit: number,
  version = 7,
): McpToolCatalogResponse {
  const end = Math.min(offset + limit, total);
  return {
    proxy_id: "agents",
    namespace: "tenant-a",
    refreshed_at: "2026-09-30T12:00:00Z",
    stale: false,
    catalogs: [
      {
        plugin_config_id: "mcp",
        catalog_state: "fresh",
        refreshed_at: "2026-09-30T12:00:00Z",
        stale: false,
        catalog_version: version,
        tool_count: total,
        servers: [],
      },
    ],
    data: Array.from({ length: Math.max(0, end - offset) }, (_, index) => catalogTool(offset + index)),
    pagination: { offset, limit, total },
  };
}

function mcpPlugin(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    id: "mcp",
    namespace: "tenant-a",
    plugin_name: "mcp_gateway",
    labels: { "provisioned-by": "ferrum-nexus", team: "agents" },
    config: {
      mode: "aggregate_router",
      endpoint: { path: "/mcp" },
      servers: { github: { upstream_url: "https://mcp.example.com/mcp", namespace: "github" } },
      policy: {
        default_action: "deny",
        tools: {
          "github.search": { action: "allow" },
          "github.create": { action: "deny" },
        },
      },
    },
    scope: "proxy",
    proxy_id: "agents",
    enabled: true,
    priority_override: null,
    trigger: null,
    api_spec_id: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

/** Edge's conditional-write contract for one plugin configuration. */
function stubPluginGateway(seed: PluginConfig, tagged = true) {
  let stored = seed;
  let revision = 1;
  const wire: { method: string; ifMatch: string | null; namespace: string | null; body?: unknown }[] = [];
  const hooks: { beforePut?: () => void } = {};
  const tag = () => `"rev-${revision}"`;
  const fetcher = vi.fn(async (request: Request) => {
    const entry = {
      method: request.method,
      ifMatch: request.headers.get("If-Match"),
      namespace: request.headers.get("X-Ferrum-Namespace"),
    } as (typeof wire)[number];
    wire.push(entry);
    if (request.method === "PUT") {
      entry.body = await request.json();
      hooks.beforePut?.();
      if (entry.ifMatch !== null && entry.ifMatch !== tag()) {
        return Response.json({ error: "Precondition Failed" }, { status: 412 });
      }
      const body = entry.body as Partial<PluginConfig>;
      stored = { ...stored, ...body, updated_at: `rev-${revision + 1}` };
      revision += 1;
      return Response.json(stored, { headers: { etag: tag() } });
    }
    return Response.json(stored, { headers: tagged ? { etag: tag() } : {} });
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    wire,
    hooks,
    read: () => stored,
    /** Another writer commits a change. */
    commit(change: (current: PluginConfig) => PluginConfig) {
      stored = change(stored);
      revision += 1;
    },
  };
}

beforeEach(() => {
  resetGatewayMetadata();
  vi.stubGlobal("Request", BasedRequest);
});

afterEach(() => {
  resetGatewayMetadata();
  vi.unstubAllGlobals();
});

describe("tool catalog read", () => {
  it("is null for a proxy no mcp_gateway applies to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "Proxy has no mcp_gateway plugin" }, { status: 404 })));
    await expect(getToolCatalog(scope, "agents")).resolves.toBeNull();
  });

  it("is an error for a proxy that does not exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "Proxy not found" }, { status: 404 })));
    await expect(getToolCatalog(scope, "agents")).rejects.toMatchObject({
      response: { status: 404 },
    });
  });

  it("reads every page under the operation's namespace", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
      const url = new URL(request.url);
      requests.push(url);
      return Response.json(catalogPage(
        1500,
        Number(url.searchParams.get("offset")),
        Number(url.searchParams.get("limit")),
      ));
    }));
    const catalog = await getToolCatalog(scope, "agents");
    expect(requests.map((url) => `${url.pathname}?${url.searchParams}`)).toEqual([
      "/api/proxy/proxies/agents/mcp/tools?offset=0&limit=1000",
      "/api/proxy/proxies/agents/mcp/tools?offset=1000&limit=1000",
    ]);
    expect(catalog?.data).toHaveLength(1500);
    expect(catalog?.pagination).toEqual({ offset: 0, limit: 1500, total: 1500 });
    expect(catalog?.catalogs[0].catalog_state).toBe("fresh");
  });

  it("refuses to stitch two catalogs together", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      return Response.json(catalogPage(1500, offset, 1000, offset === 0 ? 7 : 8));
    }));
    await expect(getToolCatalog(scope, "agents")).rejects.toBeInstanceOf(McpCatalogChangedError);
  });

  it("refuses a response for another proxy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ ...catalogPage(1, 0, 1000), proxy_id: "other" })));
    await expect(getToolCatalog(scope, "agents")).rejects.toThrow("malformed");
  });
});

describe("per-tool policy write", () => {
  it("refuses an untagged guarded policy save while preserving explicit unguarded semantics", async () => {
    const seed = mcpPlugin();
    const gateway = stubPluginGateway(seed, false);
    const refusal = await updateToolPolicy(
      scope, "mcp", "github.create", { action: "allow" },
      toolPolicyWriteGuard(seed, "github.create"), "admin",
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(GuardVerificationError);
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET"]);
    expect(gateway.read()).toEqual(seed);

    await updateToolPolicy(scope, "mcp", "github.create", { action: "allow" }, null, "admin");
    expect(gateway.wire.map((call) => [call.method, call.ifMatch])).toEqual([
      ["GET", null], ["GET", null], ["PUT", null],
    ]);
    expect(gateway.read().config.policy).toMatchObject({
      tools: { "github.create": { action: "allow" }, "github.search": { action: "allow" } },
    });
  });

  it("replaces one entry from a fresh read, conditional on that read, without labels", async () => {
    const gateway = stubPluginGateway(mcpPlugin());
    const guard = toolPolicyWriteGuard(mcpPlugin(), "github.create");

    await updateToolPolicy(scope, "mcp", "github.create", {
      action: "allow",
      allowed_groups: ["eng"],
      denied_groups: ["contractors"],
    }, guard, "admin");

    expect(gateway.wire.map((call) => [call.method, call.ifMatch, call.namespace])).toEqual([
      ["GET", null, "tenant-a"],
      ["PUT", '"rev-1"', "tenant-a"],
    ]);
    const body = gateway.wire[1].body as Record<string, unknown>;
    expect(body).not.toHaveProperty("labels");
    expect(body).not.toHaveProperty("created_at");
    expect(body).not.toHaveProperty("namespace");
    expect(body.id).toBe("mcp");
    expect(body.enabled).toBe(true);
    expect((body.config as { policy: unknown }).policy).toEqual({
      default_action: "deny",
      tools: {
        "github.search": { action: "allow" },
        "github.create": { action: "allow", allowed_groups: ["eng"], denied_groups: ["contractors"] },
      },
    });
    expect(gateway.read().labels).toEqual({ "provisioned-by": "ferrum-nexus", team: "agents" });
  });

  it("removes an entry so the default action applies", async () => {
    const gateway = stubPluginGateway(mcpPlugin());
    await updateToolPolicy(scope, "mcp", "github.create", null,
      toolPolicyWriteGuard(mcpPlugin(), "github.create"), "admin");
    const config = gateway.read().config as { policy: { tools: Record<string, unknown> } };
    expect(Object.keys(config.policy.tools)).toEqual(["github.search"]);
  });

  it("carries over a concurrent change to another tool instead of reverting it", async () => {
    const gateway = stubPluginGateway(mcpPlugin());
    const guard = toolPolicyWriteGuard(mcpPlugin(), "github.create");
    // Another writer commits between Foundry's read and its PUT: the first PUT
    // is refused with 412, the guard re-reads, finds github.create unchanged,
    // and re-sends with the other writer's entry included.
    let raced = false;
    gateway.hooks.beforePut = () => {
      if (raced) return;
      raced = true;
      gateway.commit((current) => ({
        ...current,
        config: {
          ...current.config,
          policy: {
            default_action: "deny",
            tools: {
              "github.search": { action: "hide_from_discovery" },
              "github.create": { action: "deny" },
            },
          },
        },
      }));
    };

    await updateToolPolicy(scope, "mcp", "github.create", { action: "allow" }, guard, "admin");
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(gateway.wire[1].ifMatch).toBe('"rev-1"');
    expect(gateway.wire[3].ifMatch).toBe('"rev-2"');
    expect((gateway.read().config as { policy: unknown }).policy).toEqual({
      default_action: "deny",
      tools: {
        "github.search": { action: "hide_from_discovery" },
        "github.create": { action: "allow" },
      },
    });
  });

  it("refuses, sending nothing, when this tool's entry changed since the edit began", async () => {
    const gateway = stubPluginGateway(mcpPlugin());
    const guard = toolPolicyWriteGuard(mcpPlugin(), "github.create");
    gateway.commit((current) => ({
      ...current,
      config: {
        ...current.config,
        policy: { tools: { "github.create": { action: "hide_from_discovery" } } },
      },
    }));

    const refused = await updateToolPolicy(scope, "mcp", "github.create", { action: "allow" }, guard, "admin")
      .catch((error: unknown) => error);
    expect(isStaleResourceError(refused)).toBe(true);
    if (!isStaleResourceError(refused)) return;
    expect(refused.detail.original).toEqual({
      "config.policy.tools.github.create": { action: "deny" },
    });
    expect(refused.detail.current).toEqual({
      "config.policy.tools.github.create": { action: "hide_from_discovery" },
    });
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses to add an entry someone else already wrote", async () => {
    const gateway = stubPluginGateway(mcpPlugin());
    const refused = await updateToolPolicy(scope, "mcp", "github.search", { action: "deny" },
      newToolPolicyWriteGuard("github.search"), "admin").catch((error: unknown) => error);
    expect(isStaleResourceError(refused)).toBe(true);
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses an operator save whose read masks a value, before anything is sent", async () => {
    const masked = mcpPlugin();
    masked.config = {
      ...masked.config,
      servers: { github: { upstream_url: "https://mcp.example.com/[REDACTED_PATH]", namespace: "github" } },
    };
    const gateway = stubPluginGateway(masked);
    const refused = await updateToolPolicy(scope, "mcp", "github.create", { action: "allow" },
      toolPolicyWriteGuard(masked, "github.create"), "operator").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MaskedSecretWriteError);
    expect((refused as MaskedSecretWriteError).pointers).toEqual([
      "/config/servers/github/upstream_url",
    ]);
    expect((refused as Error).message).toContain("hidden from your role");
    expect((refused as Error).message).toContain("Re-enter the URL");
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET"]);
  });

  it("lets an admin, whose reads are raw, save the same configuration", async () => {
    const masked = mcpPlugin();
    masked.config = {
      ...masked.config,
      servers: { github: { upstream_url: "https://mcp.example.com/[REDACTED_PATH]", namespace: "github" } },
    };
    const gateway = stubPluginGateway(masked);
    await updateToolPolicy(scope, "mcp", "github.create", { action: "allow" },
      toolPolicyWriteGuard(masked, "github.create"), "admin");
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET", "PUT"]);
  });

  it("refuses what Ferrum Edge would refuse, without sending it", async () => {
    const transparent = mcpPlugin({
      config: { mode: "transparent_proxy", endpoint: { path: "/mcp" }, servers: {} },
    });
    const gateway = stubPluginGateway(transparent);
    await expect(updateToolPolicy(scope, "mcp", "github.create", { action: "allow" }, null, "admin"))
      .rejects.toBeInstanceOf(McpToolPolicyError);

    stubPluginGateway(mcpPlugin({ plugin_name: "rate_limiting" }));
    await expect(updateToolPolicy(scope, "mcp", "github.create", { action: "allow" }, null, "admin"))
      .rejects.toThrow("not mcp_gateway");

    stubPluginGateway(mcpPlugin());
    await expect(updateToolPolicy(scope, "mcp", "github.create", {
      action: "deny",
      allowed_groups: ["eng"],
    }, null, "admin")).rejects.toThrow("only to an allow entry");
    expect(gateway.wire.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("masked-value advice", () => {
  it("never suggests clearing a required server URL", () => {
    expect(maskedToolPolicyAdvice(["/config/servers/github/upstream_url"]))
      .toBe("Re-enter the URL on the plugin page first, or have an admin make the change.");
    expect(maskedToolPolicyAdvice(["/config/upstream_url"])).toContain("Re-enter the URL");
    const mixed = maskedToolPolicyAdvice([
      "/config/servers/github/upstream_url",
      "/config/servers/github/headers/authorization",
    ]);
    expect(mixed).toContain("a server URL must be re-entered");
    expect(maskedToolPolicyAdvice(["/config/servers/github/headers/authorization"]))
      .toContain("clearing deletes the stored secret");
  });
});
