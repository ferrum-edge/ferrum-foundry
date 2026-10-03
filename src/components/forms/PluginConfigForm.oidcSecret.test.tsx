import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import { PluginConfigForm } from "./PluginConfigForm";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn<(data: PluginConfigCreate) => Promise<void>>(async () => {});

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

async function renderForm(config: Record<string, unknown>, enabled = true) {
  const initialData: PluginConfig = {
    id: "oidc-1",
    plugin_name: "oidc_relying_party",
    scope: "global",
    config,
    enabled,
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
  };
  await act(async () => {
    root.render(
      <PluginConfigForm
        initialData={initialData}
        availablePlugins={["oidc_relying_party"]}
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

const configWithSecret = (encryptionSecret: string, previous?: string | null) => ({
  session: {
    encryption_secret: encryptionSecret,
    ...(previous !== undefined ? { encryption_secret_previous: previous } : {}),
  },
});

describe("OIDC session encryption secret", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["the published default", "change-me-32-byte-minimum-secret!!"],
    ["a template placeholder", "replace-with-a-random-secret"],
    ["Edge's documented placeholder", "${OIDC_SESSION_SECRET_32_BYTES_MIN}"],
    ["a changeme placeholder", "ChAnGeMe"],
    ["a change_me placeholder", "CHANGE_ME"],
    ["a replace-me placeholder", "RePlAcE-Me-with-a-random-secret"],
    ["a short secret", "too-short"],
  ])("blocks enabling with %s", async (_label, secret) => {
    await renderForm(configWithSecret(secret));
    await submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("session encryption secret");
  });

  it.each([
    ["the published default", "change-me-32-byte-minimum-secret!!"],
    ["Edge's documented placeholder", "${OIDC_SESSION_SECRET_32_BYTES_MIN}"],
    ["a change_me placeholder", "CHANGE_ME"],
    ["a replace-me placeholder", "replace-me-with-a-random-secret"],
    ["a short secret", "short"],
  ])("blocks enabling with %s as the previous key", async (_label, previous) => {
    await renderForm(configWithSecret("operator-generated-secret-value", previous));
    await submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("session encryption secret");
  });

  it("allows a disabled configuration to be saved before the operator sets the key", async () => {
    await renderForm(configWithSecret(""), false);
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("allows an operator-supplied key", async () => {
    await renderForm(configWithSecret("operator-generated-session-secret"));
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("allows 32-byte current and previous keys", async () => {
    await renderForm(configWithSecret("c".repeat(32), "p".repeat(32)));
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("allows an omitted or null previous key", async () => {
    await renderForm(configWithSecret("operator-generated-session-secret", null));
    await submit();

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
