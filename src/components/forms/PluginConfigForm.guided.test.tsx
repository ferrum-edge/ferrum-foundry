/* ------------------------------------------------------------------ */
/*  Guided plugin configuration in the form (issue #383)               */
/* ------------------------------------------------------------------ */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginConfigForm } from "./PluginConfigForm";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import { formatPluginName } from "@/lib/pluginConfigDefaults";

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

function existing(pluginName: string, config: Record<string, unknown>): PluginConfig {
  return {
    id: `${pluginName}-1`,
    plugin_name: pluginName,
    scope: "global",
    config,
    enabled: true,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  };
}

async function renderForm(pluginName: string, config: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <PluginConfigForm
        initialData={existing(pluginName, config)}
        availablePlugins={[pluginName]}
        isLoading={false}
        onSubmit={onSubmit}
      />,
    );
  });
}

function labelledControl(label: string): HTMLElement {
  const field = [...host.querySelectorAll("label")].find(
    (element) => element.textContent?.replace("*", "").trim() === label,
  );
  expect(field, `label ${label}`).toBeTruthy();
  const id = field!.getAttribute("for");
  const control = id ? host.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
  expect(control, `control for ${label}`).toBeTruthy();
  return control!;
}

async function type(label: string, value: string) {
  const control = labelledControl(label) as HTMLInputElement | HTMLTextAreaElement;
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function configJsonField(): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Plugin config JSON"]',
  )!;
}

describe("guided configuration", () => {
  it("labels the fields so no field name has to be copied from source", async () => {
    await renderForm("key_auth", { key_location: "header:X-API-Key" });

    expect(host.textContent).toContain("Key location");
    expect(host.textContent).toContain("Hide credentials from the backend");
    // Descriptions are transcribed from the schema, not invented.
    expect(host.textContent).toContain("header:<name> or query:<name>");
    // The raw editor is not the default surface any more.
    expect(configJsonField()).toBeNull();
  });

  it("saves an edit made through the labelled control", async () => {
    await renderForm("key_auth", { key_location: "header:X-API-Key" });
    await type("Key location", "query:api_key");
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ config: { key_location: "query:api_key" } }),
      undefined,
    );
  });

  it("preserves an explicit null boolean when another field is edited", async () => {
    await renderForm("key_auth", {
      key_location: "header:X-API-Key",
      hide_credentials: null,
    });
    await type("Key location", "query:api_key");
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { key_location: "query:api_key", hide_credentials: null },
      }),
      undefined,
    );
  });

  it("shows an accessible inline error and refuses to submit an out-of-range value", async () => {
    await renderForm("rate_limiting", {
      limits: [{ scope: "default", requests_per_second: 400 }],
    });
    await type("Requests per second", "2000000");

    const control = labelledControl("Requests per second");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const described = control.getAttribute("aria-describedby")!;
    const message = host.querySelector(`#${CSS.escape(described.split(" ")[0]!)}`);
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toContain("at most 1000000");

    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses an empty required list", async () => {
    await renderForm("cors", { allowed_origins: ["https://app.example.com"] });
    await type("Allowed origins", "");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("at least 1 entry");
  });

  it("states a deployment prerequisite without claiming it is satisfied", async () => {
    await renderForm("key_auth", { key_location: "header:X-API-Key" });
    expect(host.textContent).toContain("Deployment prerequisite (Foundry cannot confirm it)");
    expect(host.textContent).toContain("Consumers must hold a keyauth credential");
  });

  it("says what omitting a field means instead of materialising a default", async () => {
    await renderForm("key_auth", { key_location: "header:X-API-Key" });
    expect(host.textContent).toContain("Not set");
    expect(host.textContent).toContain("the gateway uses");

    // And omission survives the save.
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ config: { key_location: "header:X-API-Key" } }),
      undefined,
    );
  });

  it("preserves a field the guided view does not model", async () => {
    await renderForm("key_auth", {
      key_location: "header:X-API-Key",
      a_field_from_a_newer_gateway: { nested: true },
    });
    await type("Key location", "header:X-Tenant-Key");
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          key_location: "header:X-Tenant-Key",
          a_field_from_a_newer_gateway: { nested: true },
        },
      }),
      undefined,
    );
  });

  it("falls back to raw JSON with a reason it can be acted on", async () => {
    await renderForm("cors", {
      allowed_origins: [{ prefix: "https://app." }],
      allow_credentials: false,
    });

    expect(host.textContent).toContain("Guided fields are unavailable");
    expect(host.textContent).toContain("StringMatch");
    expect(host.textContent).toContain("Nothing has been changed");
    // The whole configuration is still editable, and still intact.
    const raw = configJsonField();
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw.value)).toEqual({
      allowed_origins: [{ prefix: "https://app." }],
      allow_credentials: false,
    });
  });

  it("round-trips JSON to guided to JSON without changing the configuration", async () => {
    const config = {
      limit_by: "consumer",
      expose_headers: true,
      limits: [{ scope: "default", requests_per_second: 400, requests_per_minute: 20000 }],
      sync_mode: "local",
      an_unmodelled_key: [1, 2],
    };
    await renderForm("rate_limiting", config);

    await clickButton("Edit as JSON");
    expect(JSON.parse(configJsonField().value)).toEqual(config);

    await clickButton("Guided fields");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ config }),
      undefined,
    );
  });

  it("leaves a plugin without a guided schema on the raw editor", async () => {
    await renderForm("request_size_limiting", { max_bytes: 4096 });
    expect(configJsonField()).not.toBeNull();
    expect(host.textContent).not.toContain("Guided fields are unavailable");
  });

  it("saves a rate limit with a stored Redis password, keeping the password", async () => {
    await renderForm("rate_limiting", {
      limits: [{ scope: "default", requests_per_second: 400 }],
      sync_mode: "redis",
      redis_url: "redis://redis.internal:6379/0",
      redis_password: "stored-password",
    });
    // Never displayed.
    expect(host.innerHTML).not.toContain("stored-password");

    await type("Requests per second", "500");
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          limits: [{ scope: "default", requests_per_second: 500 }],
          redis_password: "stored-password",
        }),
      }),
      undefined,
    );
  });

  it("edits a gateway-accepted enum spelling as JSON rather than refusing it", async () => {
    await renderForm("rate_limiting", {
      limit_by: "Consumer",
      limits: [{ scope: "default", requests_per_second: 400 }],
    });
    expect(host.textContent).toContain("Guided fields are unavailable");
    expect(JSON.parse(configJsonField().value).limit_by).toBe("Consumer");
    await submit();
    expect(onSubmit).toHaveBeenCalled();
  });

  it("seeds the chosen plugin's default config into the guided fields in create mode", async () => {
    await act(async () => {
      root.render(
        <PluginConfigForm
          availablePlugins={["prometheus_metrics", "key_auth"]}
          isLoading={false}
          onSubmit={onSubmit}
        />,
      );
    });

    const choose = async (pluginName: string) => {
      const trigger = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
        (entry) =>
          document.getElementById(entry.getAttribute("aria-labelledby") ?? "")?.textContent
            ?.replace("*", "")
            .trim() === "Plugin Name",
      )!;
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (entry) => entry.textContent === formatPluginName(pluginName),
      )!;
      await act(async () => {
        option.focus();
        option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    };

    await choose("prometheus_metrics");
    await choose("key_auth");
    expect((labelledControl("Key location") as HTMLInputElement).value).toBe("header:X-API-Key");

    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0].config).toMatchObject({ key_location: "header:X-API-Key" });
  });
});
