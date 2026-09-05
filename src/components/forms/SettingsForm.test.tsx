import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { decodeJwt } from "jose";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../../../server/auth-types";
import type { RuntimeConfig } from "../../../server/config";
import { SettingsForm } from "./SettingsForm";

const { get, put, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/api/client", () => ({ api: { get, put } }));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast }),
}));

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let config: typeof import("../../../server/config");
let generateToken: typeof import("../../../server/jwt").generateToken;
let submitted: Partial<RuntimeConfig>;

const principal: AuthPrincipal = {
  subject: "settings-test",
  displayName: "Settings test",
  role: "admin",
  namespaces: ["tenant-a"],
  authMode: "static",
};

function publicSettings() {
  // Model the HTTP response: absent optional claims disappear on the wire.
  return JSON.parse(JSON.stringify(config.getPublicRuntimeConfig()));
}

async function renderForm() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsForm />
      </QueryClientProvider>,
    );
  });
}

function input(id: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Missing input: ${id}`);
  return element;
}

async function change(id: string, value: string) {
  await act(async () => {
    const element = input(id);
    // Use the native setter so React observes a real DOM input change.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Missing native input value setter");
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  const button = Array.from(host.querySelectorAll("button")).find(
    (element) => element.textContent === "Save Settings",
  );
  if (!button) throw new Error("Missing Save Settings button");
  await act(async () => button.click());
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FERRUM_")) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FERRUM_ADMIN_URL", "http://127.0.0.1:9000");
  vi.stubEnv("FERRUM_JWT_SECRET", "settings-test-signing-secret-long-enough");
  vi.stubEnv("FERRUM_BFF_AUTH_TOKEN", "settings-test-session-token-long-enough");
  vi.stubEnv("FERRUM_ALLOW_RUNTIME_SETTINGS", "true");
  vi.stubEnv("FERRUM_ADMIN_ALLOWED_ORIGINS", "http://127.0.0.1:9000");
  vi.stubEnv("FERRUM_JWT_AUDIENCE", "old-audience");
  vi.stubEnv("FERRUM_JWT_NAMESPACES", "tenant-a");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);

  config = await import("../../../server/config");
  ({ generateToken } = await import("../../../server/jwt"));
  get.mockImplementation(() => ({ json: async () => publicSettings() }));
  put.mockImplementation((_path, options: { json: Partial<RuntimeConfig> }) => ({
    json: async () => {
      // Exercise the form's actual payload through JSON serialization and the
      // real server updater, just as the settings PUT route does.
      submitted = JSON.parse(JSON.stringify(options.json));
      await config.updateRuntimeConfig(submitted);
      return publicSettings();
    },
  }));
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SettingsForm runtime saves", () => {
  it("serializes explicit clears and removes the old audience from subsequent JWTs", async () => {
    const before = await generateToken(config.loadConfig(), principal);
    expect(decodeJwt(before).aud).toBe("old-audience");
    await renderForm();
    expect(input("jwt-audience").value).toBe("old-audience");
    await change("jwt-audience", "");
    await change("namespace-grants", "");
    await save();

    expect(put).toHaveBeenCalledWith("api/settings", expect.any(Object));
    expect(submitted).toMatchObject({ jwtAudience: "", jwtNamespaces: [] });
    expect(toast).toHaveBeenCalledWith("success", "Settings saved successfully");
    const after = await generateToken(config.loadConfig(), principal);
    expect(after).not.toBe(before);
    expect(decodeJwt(after)).not.toHaveProperty("aud");
    expect(publicSettings()).not.toHaveProperty("jwtAudience");
    expect(publicSettings()).not.toHaveProperty("jwtNamespaces");
    expect(queryClient.getQueryData(["settings"])).toEqual(publicSettings());

    await act(async () => root.render(null));
    await renderForm();
    expect(input("jwt-audience").value).toBe("");
    expect(input("namespace-grants").value).toBe("");
  });

  it("replaces the draft and cached settings with the canonical save response", async () => {
    await renderForm();
    await change("jwt-issuer", "  canonical-issuer  ");
    await change("jwt-audience", " edge-admin , edge-ops ");
    await save();

    expect(input("jwt-issuer").value).toBe("canonical-issuer");
    expect(input("jwt-audience").value).toBe("edge-admin, edge-ops");
    expect(queryClient.getQueryData(["settings"])).toEqual(publicSettings());
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      jwtIssuer: "canonical-issuer",
      jwtAudience: ["edge-admin", "edge-ops"],
    });
  });

  it("keeps runtime editing unavailable when the server gate is disabled", async () => {
    vi.stubEnv("FERRUM_ALLOW_RUNTIME_SETTINGS", "false");
    await renderForm();

    expect(input("jwt-audience").disabled).toBe(true);
    expect(host.textContent).not.toContain("Save Settings");
    expect(put).not.toHaveBeenCalled();
  });
});
