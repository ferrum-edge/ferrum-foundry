/* ------------------------------------------------------------------ */
/*  Plugin configs read through a masked projection (ferrum-edge#5925) */
/* ------------------------------------------------------------------ */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginConfigForm } from "./PluginConfigForm";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import { MASKED_FIELD_NOTICE } from "@/api/maskedSecrets";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn<(data: PluginConfigCreate, proxyGroupIds?: string[]) => Promise<void>>(
  async () => {},
);

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

async function renderForm(pluginName: string, config: Record<string, unknown>) {
  const initialData: PluginConfig = {
    id: `${pluginName}-1`,
    plugin_name: pluginName,
    scope: "global",
    config,
    enabled: true,
    created_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z",
  };
  await act(async () => {
    root.render(
      <PluginConfigForm
        initialData={initialData}
        availablePlugins={[pluginName]}
        isLoading={false}
        onSubmit={onSubmit}
      />,
    );
  });
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function maskedList(): string[] {
  const region = host.querySelector('[aria-label="Fields hidden from your role"]');
  return [...(region?.querySelectorAll("code") ?? [])].map((code) => code.textContent ?? "");
}

async function clear(pointer: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === `Clear ${pointer}`,
  );
  expect(button, `clear ${pointer}`).toBeTruthy();
  await act(async () => button!.click());
}

async function editJson(config: Record<string, unknown>) {
  const field = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Plugin config JSON"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      JSON.stringify(config, null, 2),
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("plugin configuration with masked secrets", () => {
  const maskedHttpLogging = {
    endpoint_url: "https://collector.example.com/[REDACTED_PATH]?[REDACTED_QUERY]",
    custom_headers: { "x-honeycomb-team": "[REDACTED]" },
    batch_size: 50,
  };

  it("marks each placeholder and blocks Save while any remains", async () => {
    await renderForm("http_logging", maskedHttpLogging);

    expect(maskedList()).toEqual([
      "/config/endpoint_url",
      "/config/custom_headers/x-honeycomb-team",
    ]);
    expect(host.textContent).toContain(MASKED_FIELD_NOTICE);
    expect(host.textContent).toContain("deletes the stored secret");

    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("2 fields are hidden from your role");

    // Editing an unrelated field does not lift the block.
    await editJson({ ...maskedHttpLogging, batch_size: 75 });
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears a placeholder by omitting the field, and saves once each is resolved", async () => {
    await renderForm("http_logging", maskedHttpLogging);

    await clear("/config/custom_headers/x-honeycomb-team");
    expect(maskedList()).toEqual(["/config/endpoint_url"]);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 field is hidden from your role");

    // Re-entering the real value resolves the other one.
    await editJson({
      endpoint_url: "https://collector.example.com/v1/ingest?api_key=rotated",
      custom_headers: {},
      batch_size: 50,
    });
    expect(maskedList()).toEqual([]);
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].config).toEqual({
      endpoint_url: "https://collector.example.com/v1/ingest?api_key=rotated",
      custom_headers: {},
      batch_size: 50,
    });
  });

  it("clears a masked secret from the guided editor", async () => {
    await renderForm("rate_limiting", {
      limits: [{ scope: "default", requests_per_second: 400 }],
      sync_mode: "redis",
      redis_url: "redis://redis.internal:6379/0",
      redis_password: "[REDACTED]",
    });
    expect(maskedList()).toEqual(["/config/redis_password"]);

    await submit();
    expect(onSubmit).not.toHaveBeenCalled();

    await clear("/config/redis_password");
    expect(maskedList()).toEqual([]);
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
    const { config } = onSubmit.mock.calls[0]![0];
    expect(config).not.toHaveProperty("redis_password");
    expect(config).toMatchObject({
      sync_mode: "redis",
      redis_url: "redis://redis.internal:6379/0",
    });
  });

  it("does not flag a value that only resembles a placeholder", async () => {
    await renderForm("http_logging", {
      endpoint_url: "https://collector.example.com/redacted/ingest",
      batch_size: 50,
    });
    expect(maskedList()).toEqual([]);
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
