import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_GATEWAY_AGGREGATE_ONLY_PATHS } from "@/lib/mcpGatewayConfig";
import { PluginConfigForm } from "./PluginConfigForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn(async () => {});

beforeEach(() => {
  onSubmit.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function renderForm(config?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <PluginConfigForm
        defaults={{ pluginName: "mcp_gateway", scope: "global" }}
        availablePlugins={["mcp_gateway"]}
        isLoading={false}
        onSubmit={onSubmit}
        {...(config
          ? {
              initialData: {
                id: "mcp-1",
                plugin_name: "mcp_gateway",
                scope: "global",
                config,
                enabled: true,
                created_at: "2026-09-08T00:00:00Z",
                updated_at: "2026-09-08T00:00:00Z",
              },
            }
          : {})}
      />,
    );
  });
}

async function chooseMode(label: string) {
  const trigger = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find((entry) =>
    document.getElementById(entry.getAttribute("aria-labelledby") ?? "")?.textContent === "Mode",
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent === label,
  )!;
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function configTextarea(): HTMLTextAreaElement {
  return host.querySelector('textarea[aria-label="Plugin config JSON"]')!;
}

function hasAggregateOnlyKey(config: Record<string, unknown>, path: string): boolean {
  const [section, field] = path.split(".");
  return (config[section] as Record<string, unknown> | undefined)?.[field] !== undefined;
}

describe("PluginConfigForm mcp_gateway", () => {
  it("submits transparent mode without aggregate-only keys", async () => {
    await renderForm();
    await chooseMode("Transparent proxy");
    await submitForm();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0].config as Record<string, unknown>;
    expect(submitted.mode).toBe("transparent_proxy");
    for (const path of MCP_GATEWAY_AGGREGATE_ONLY_PATHS) {
      expect(hasAggregateOnlyKey(submitted, path)).toBe(false);
    }
  });

  it("submits aggregate mode with policy and discovery defaults intact", async () => {
    await renderForm();
    await submitForm();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0].config as Record<string, unknown>;
    expect(submitted).toMatchObject({
      mode: "aggregate_router",
      discovery: { public_base_url: "https://mcp.example.com" },
      policy: {
        default_action: "deny",
        tools: { "github.search_issues": { action: "allow" } },
      },
    });
  });

  it("restores aggregate fields after a mode round trip without losing other edits", async () => {
    await renderForm({
      mode: "aggregate_router",
      endpoint: { path: "/operator-mcp", protocol_versions: ["2025-11-25"] },
      servers: {
        github: {
          upstream_url: "https://mcp-github.internal.example.com/mcp",
          namespace: "github",
          expose_tools: true,
        },
      },
      discovery: { public_base_url: "https://mcp.example.com" },
      policy: {
        default_action: "allow",
        tools: {
          "github.search_issues": { action: "allow" },
          "github.create_issue": { action: "deny" },
        },
      },
    });

    await chooseMode("Transparent proxy");
    expect(JSON.parse(configTextarea().value).endpoint).toEqual({
      path: "/operator-mcp",
      protocol_versions: ["2025-11-25"],
    });
    expect(JSON.parse(configTextarea().value).policy).toBeUndefined();

    await chooseMode("Aggregate router");
    const restored = JSON.parse(configTextarea().value) as Record<string, unknown>;
    expect(restored.endpoint).toEqual({
      path: "/operator-mcp",
      protocol_versions: ["2025-11-25"],
    });
    expect(restored.policy).toEqual({
      default_action: "allow",
      tools: {
        "github.search_issues": { action: "allow" },
        "github.create_issue": { action: "deny" },
      },
    });
  });
});
