/* ------------------------------------------------------------------ */
/*  Plugin configs read through a masked projection (ferrum-edge#5925) */
/* ------------------------------------------------------------------ */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginConfigForm } from "./PluginConfigForm";
import type { PluginConfig, PluginConfigCreate, PluginTrigger } from "@/api/types";
import { MASKED_FIELD_NOTICE } from "@/api/maskedSecrets";
import type { GatewayRole } from "@/lib/capabilities";

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
  // A blocked submit schedules focusing the first invalid field for the next
  // frame; let it run while the form and the scrollIntoView stub still exist.
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function renderForm(
  pluginName: string,
  config: Record<string, unknown>,
  role?: GatewayRole | null,
  trigger?: PluginTrigger,
) {
  const initialData: PluginConfig = {
    id: `${pluginName}-1`,
    plugin_name: pluginName,
    scope: "global",
    config,
    trigger,
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
        role={role}
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

function codesIn(label: string): string[] {
  const region = host.querySelector(`[aria-label="${label}"]`);
  return [...(region?.querySelectorAll("code") ?? [])].map((code) => code.textContent ?? "");
}

function maskedList(): string[] {
  return codesIn("Fields hidden from your role");
}

function warnedList(): string[] {
  return codesIn("Values that look like placeholders");
}

function sourceList(): string[] {
  return codesIn("TLS sources held by the gateway");
}

function reservedList(): string[] {
  return codesIn("Reserved placeholder values");
}

function clearButton(pointer: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === `Clear ${pointer}`,
  );
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

  it("lets an admin save a literal placeholder, whose reads are raw", async () => {
    await renderForm("http_logging", maskedHttpLogging, "admin");

    expect(maskedList()).toEqual([]);
    expect(host.textContent).not.toContain("Hidden from your role");
    expect(warnedList()).toEqual([
      "/config/endpoint_url",
      "/config/custom_headers/x-honeycomb-team",
    ]);

    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].config).toEqual(maskedHttpLogging);
  });

  it("blocks an operator only where the read masks the field", async () => {
    const config = {
      action: "redact",
      docs_url: "https://docs.example.com/[REDACTED_PATH]",
      webhook_secret: "[REDACTED]",
    };
    await renderForm("ai_prompt_shield", config, "operator");

    expect(maskedList()).toEqual(["/config/webhook_secret"]);
    expect(warnedList()).toEqual(["/config/docs_url"]);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();

    await clear("/config/webhook_secret");
    expect(maskedList()).toEqual([]);
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].config).toEqual({
      action: "redact",
      docs_url: "https://docs.example.com/[REDACTED_PATH]",
    });
  });

  it("blocks a reserved literal without calling it a secret or offering Clear (ferrum-edge#7054)", async () => {
    await renderForm(
      "ai_prompt_shield",
      { action: "redact", redaction_placeholder: "[REDACTED]" },
      "operator",
    );
    expect(reservedList()).toEqual(["/config/redaction_placeholder"]);
    expect(maskedList()).toEqual([]);
    expect(warnedList()).toEqual([]);
    expect(clearButton("/config/redaction_placeholder")).toBeUndefined();
    expect(host.textContent).not.toContain("Hidden from your role");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "1 field carries the [REDACTED] placeholder, which Ferrum Edge refuses from your role",
    );

    // A real value unblocks the save and keeps the setting.
    await editJson({ action: "redact", redaction_placeholder: "[PII]" });
    expect(reservedList()).toEqual([]);
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].config).toEqual({
      action: "redact",
      redaction_placeholder: "[PII]",
    });
  });

  it("asks for a gateway-held TLS source again instead of offering Clear", async () => {
    await renderForm(
      "mesh_route_dispatch",
      {
        rules: [
          {
            request_transform: [{ operation: "set", value: "[REDACTED]" }],
            destination: { backend_tls: { client_key_path: "[REDACTED]" } },
          },
        ],
      },
      "operator",
    );
    expect(maskedList()).toEqual(["/config/rules/0/request_transform/0/value"]);
    expect(sourceList()).toEqual(["/config/rules/0/destination/backend_tls/client_key_path"]);
    expect(clearButton("/config/rules/0/request_transform/0/value")).toBeTruthy();
    expect(clearButton("/config/rules/0/destination/backend_tls/client_key_path")).toBeUndefined();
    expect(host.textContent).toContain("certificate or private-key source the gateway");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps every placeholder blocking for a plugin it has no rules for", async () => {
    await renderForm("custom_plugin", { redaction_placeholder: "[REDACTED]" }, "operator");
    expect(maskedList()).toEqual(["/config/redaction_placeholder"]);
    expect(warnedList()).toEqual([]);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("plugin trigger with masked operands", () => {
  const maskedTrigger: PluginTrigger = {
    when: {
      all: [
        { not: { match: { header: { name: "x-skip-waf", value: { exact: ["[REDACTED]"] } } } } },
        { match: { query: { name: "debug", value: { regex: "[REDACTED]" } } } },
        { match: { path: { prefix: ["/api/"] } } },
      ],
    },
  };
  const operandSites = [
    "/trigger/when/all/0/not/match/header/value/exact/0",
    "/trigger/when/all/1/match/query/value/regex",
  ];

  function triggerList(): string[] {
    return codesIn("Trigger values hidden from your role");
  }

  async function editTrigger(trigger: unknown) {
    const field = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Execution trigger JSON"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        JSON.stringify(trigger, null, 2),
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it.each(["operator", null] as const)(
    "blocks Save for a %s role until each operand is re-entered",
    async (role) => {
      await renderForm("cors", {}, role, maskedTrigger);

      expect(triggerList()).toEqual(operandSites);
      expect(maskedList()).toEqual([]);
      // No Clear: a predicate without its operand is not one Edge accepts.
      for (const pointer of operandSites) expect(clearButton(pointer)).toBeUndefined();

      await submit();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(host.textContent).toContain("2 trigger values are hidden from your role");

      const reentered = structuredClone(maskedTrigger);
      reentered.when.all![0].not!.match!.header!.value!.exact = ["synthetic-real-token"];
      reentered.when.all![1].match!.query!.value!.regex = "on|yes";
      await editTrigger(reentered);
      expect(triggerList()).toEqual([]);
      await submit();
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0].trigger).toEqual(reentered);
    },
  );

  it("saves once the trigger is turned off, which removes it", async () => {
    await renderForm("cors", {}, "operator", maskedTrigger);
    const toggle = [...host.querySelectorAll<HTMLLabelElement>("label")]
      .filter((label) => label.textContent === "Enabled")
      .at(-1)!
      .querySelector("input")!;
    await act(async () => toggle.click());
    expect(triggerList()).toEqual([]);
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].trigger).toBeNull();
  });

  it("lets an admin save the trigger as read, with a warning", async () => {
    await renderForm("cors", {}, "admin", maskedTrigger);
    expect(triggerList()).toEqual([]);
    expect(codesIn("Trigger values that look like placeholders")).toEqual(operandSites);
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("blocks a placeholder inside ill-typed content under a visible key", async () => {
    await renderForm("cors", {}, "operator", {
      when: { match: { header: { name: { pasted: "[REDACTED]" } } } },
    } as unknown as PluginTrigger);
    expect(triggerList()).toEqual(["/trigger/when/match/header/name/pasted"]);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("only warns about a placeholder in a visible predicate", async () => {
    await renderForm("cors", {}, "operator", {
      when: { match: { path: { exact: ["[REDACTED]"] } } },
    });
    expect(triggerList()).toEqual([]);
    expect(codesIn("Trigger values that look like placeholders")).toEqual([
      "/trigger/when/match/path/exact/0",
    ]);
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
