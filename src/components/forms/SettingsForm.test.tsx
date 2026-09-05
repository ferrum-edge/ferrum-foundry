import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let submitted: Record<string, unknown>;
let currentSettings: Record<string, unknown>;
let savedSettings: Record<string, unknown>;

const baseSettings = {
  adminUrl: "http://127.0.0.1:9000",
  jwtIssuer: "ferrum-edge",
  jwtTtl: 900,
  jwtRole: "admin",
  tlsCaConfigured: false,
  tlsVerify: true,
  connectTimeout: 5000,
  readTimeout: 60000,
  writeTimeout: 60000,
  runtimeSettingsEnabled: true,
};

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submitted = {};
  currentSettings = {
    ...baseSettings,
    jwtAudience: "old-audience",
    jwtNamespaces: ["tenant-a"],
  };
  // Cleared optional claims are absent from the canonical HTTP response.
  savedSettings = { ...baseSettings };
  get.mockImplementation(() => ({ json: async () => currentSettings }));
  put.mockImplementation((_path, options: { json: Record<string, unknown> }) => ({
    json: async () => {
      // Preserve the wire boundary: JSON serialization drops undefined values.
      submitted = JSON.parse(JSON.stringify(options.json));
      currentSettings = savedSettings;
      return savedSettings;
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
  vi.unstubAllGlobals();
});

describe("SettingsForm runtime saves", () => {
  it("serializes explicit clears and adopts the canonical response", async () => {
    await renderForm();
    expect(input("jwt-audience").value).toBe("old-audience");
    await change("jwt-audience", "");
    await change("namespace-grants", "");
    await save();

    expect(put).toHaveBeenCalledWith("api/settings", expect.any(Object));
    expect(submitted).toMatchObject({ jwtAudience: "", jwtNamespaces: [] });
    expect(toast).toHaveBeenCalledWith("success", "Settings saved successfully");
    expect(queryClient.getQueryData(["settings"])).toEqual(savedSettings);
    expect(input("jwt-audience").value).toBe("");
    expect(input("namespace-grants").value).toBe("");

    await act(async () => root.render(null));
    await renderForm();
    expect(input("jwt-audience").value).toBe("");
    expect(input("namespace-grants").value).toBe("");
  });

  it("replaces the draft and cached settings with the canonical save response", async () => {
    savedSettings = {
      ...baseSettings,
      jwtIssuer: "canonical-issuer",
      jwtAudience: ["edge-admin", "edge-ops"],
      jwtNamespaces: ["tenant-a"],
    };
    await renderForm();
    await change("jwt-issuer", "  canonical-issuer  ");
    await change("jwt-audience", " edge-admin , edge-ops ");
    await save();

    expect(input("jwt-issuer").value).toBe("canonical-issuer");
    expect(input("jwt-audience").value).toBe("edge-admin, edge-ops");
    expect(queryClient.getQueryData(["settings"])).toEqual(savedSettings);
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      jwtIssuer: "canonical-issuer",
      jwtAudience: ["edge-admin", "edge-ops"],
    });
  });

  it("keeps runtime editing unavailable when the server gate is disabled", async () => {
    currentSettings.runtimeSettingsEnabled = false;
    await renderForm();

    expect(input("jwt-audience").disabled).toBe(true);
    expect(host.textContent).not.toContain("Save Settings");
    expect(put).not.toHaveBeenCalled();
  });
});
