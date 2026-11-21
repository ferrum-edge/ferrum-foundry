import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ky, { type Options } from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blurField, clearText, typeText } from "@/test/fields";
import { SettingsForm } from "./SettingsForm";

const { get, put, toast, session } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toast: vi.fn(),
  // An admin session; `null` grants conclude nothing, as before a session read.
  session: { namespaceScoped: null as boolean | null },
}));

vi.mock("@/api/client", () => ({
  api: { get, put },
  HANDLED_STATUSES: "handledStatuses",
  getApiErrorMessage: async (error: Error, fallback: string) => {
    const detail = (error as { data?: { error?: string } }).data?.error;
    return detail ? `${error.message}: ${detail}` : fallback;
  },
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast }),
}));
vi.mock("@/stores/capabilities", async () => {
  const { resolveCapabilities } = await import("@/lib/capabilities");
  return {
    useCapabilities: () => {
      const facts = {
        role: "admin" as const,
        namespaceScoped: session.namespaceScoped,
        mode: null,
        adminWritesEnabled: null,
        status: null,
      };
      return { capabilities: resolveCapabilities(facts), facts };
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let submitted: Record<string, unknown>;
let currentSettings: Record<string, unknown>;
let savedSettings: Record<string, unknown>;

const baseSettings = {
  authMode: "static",
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

function inputByLabel(labelText: string): HTMLInputElement {
  const label = Array.from(host.querySelectorAll("label")).find(
    (element) => element.textContent?.trim() === labelText,
  );
  if (!label) throw new Error(`Missing label: ${labelText}`);
  const id = label.getAttribute("for");
  if (!id) throw new Error(`Label ${labelText} has no for attribute`);
  const element = host.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
  if (!element) throw new Error(`Missing input for label: ${labelText}`);
  return element;
}

async function change(labelText: string, value: string) {
  await act(async () => {
    const element = inputByLabel(labelText);
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
  session.namespaceScoped = null;
  submitted = {};
  currentSettings = {
    ...baseSettings,
    jwtAudience: "old-audience",
    jwtNamespaces: ["tenant-a"],
  };
  // Cleared optional claims are absent from the canonical HTTP response; the
  // every-namespace grant is always the explicit wildcard.
  savedSettings = { ...baseSettings, jwtNamespaces: ["*"] };
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
    expect(inputByLabel("JWT Audience").value).toBe("old-audience");
    await change("JWT Audience", "");
    await change("Namespace grants", " * ");
    await save();

    expect(put).toHaveBeenCalledWith("api/settings", expect.any(Object));
    expect(submitted).toMatchObject({ jwtAudience: "", jwtNamespaces: ["*"] });
    expect(toast).toHaveBeenCalledWith("success", "Settings saved successfully");
    expect(queryClient.getQueryData(["settings"])).toEqual(savedSettings);
    expect(inputByLabel("JWT Audience").value).toBe("");
    expect(inputByLabel("Namespace grants").value).toBe("*");

    await act(async () => root.render(null));
    await renderForm();
    expect(inputByLabel("JWT Audience").value).toBe("");
    expect(inputByLabel("Namespace grants").value).toBe("*");
  });

  it("replaces the draft and cached settings with the canonical save response", async () => {
    savedSettings = {
      ...baseSettings,
      jwtIssuer: "canonical-issuer",
      jwtAudience: ["edge-admin", "edge-ops"],
      jwtNamespaces: ["tenant-a"],
    };
    await renderForm();
    await change("JWT Issuer", "  canonical-issuer  ");
    await change("JWT Audience", " edge-admin , edge-ops ");
    await save();

    expect(inputByLabel("JWT Issuer").value).toBe("canonical-issuer");
    expect(inputByLabel("JWT Audience").value).toBe("edge-admin, edge-ops");
    expect(queryClient.getQueryData(["settings"])).toEqual(savedSettings);
    expect(queryClient.getQueryData(["settings"])).toMatchObject({
      jwtIssuer: "canonical-issuer",
      jwtAudience: ["edge-admin", "edge-ops"],
    });
  });

  it("disables proxy-managed identity fields and omits them from unrelated saves", async () => {
    currentSettings.authMode = "trusted-proxy";
    savedSettings = { ...currentSettings, jwtAudience: "updated-audience" };
    await renderForm();

    expect(host.textContent).toContain("Your identity proxy manages gateway roles");
    expect(host.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    expect(inputByLabel("Namespace grants").disabled).toBe(true);
    expect(inputByLabel("JWT Audience").disabled).toBe(false);
    await change("JWT Audience", "updated-audience");
    await save();

    expect(submitted).toMatchObject({ jwtAudience: "updated-audience" });
    expect(submitted).not.toHaveProperty("jwtRole");
    expect(submitted).not.toHaveProperty("jwtNamespaces");
    expect(submitted).not.toHaveProperty("authMode");
    expect(toast).toHaveBeenCalledWith("success", "Settings saved successfully");
  });

  it("shows a namespace-scoped admin the settings read-only and sends nothing", async () => {
    session.namespaceScoped = true;
    await renderForm();

    const notice = host.querySelector<HTMLElement>('[data-capability-blocked="namespace-scope"]');
    expect(notice?.textContent).toContain("BFF connection settings are read-only");
    expect(notice?.textContent).toContain("namespace grants do not scope");
    for (const label of [
      "Admin URL",
      "JWT Issuer",
      "JWT TTL (seconds)",
      "JWT Audience",
      "Namespace grants",
      "Read Timeout (ms)",
    ]) {
      expect(inputByLabel(label).disabled, label).toBe(true);
      expect(inputByLabel(label).readOnly, label).toBe(true);
    }
    // The values are the server's, not an environment lock.
    expect(inputByLabel("Admin URL").value).toBe("http://127.0.0.1:9000");
    expect(host.textContent).not.toContain("Connection and signing settings are immutable");
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.find((element) => element.textContent === "Save Settings")?.disabled).toBe(true);
    await save();
    expect(put).not.toHaveBeenCalled();
    // Testing the connection is a read and stays available.
    expect(buttons.find((element) => element.textContent === "Test Connection")?.disabled).toBe(false);
  });

  it("keeps runtime editing unavailable when the server gate is disabled", async () => {
    currentSettings.runtimeSettingsEnabled = false;
    await renderForm();

    expect(inputByLabel("JWT Audience").disabled).toBe(true);
    expect(host.textContent).not.toContain("Save Settings");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("SettingsForm editing drafts", () => {
  it("saves namespace grants typed one character at a time (#401)", async () => {
    await renderForm();
    const grants = inputByLabel("Namespace grants");
    await clearText(grants);
    await typeText(grants, "tenant-a, tenant-b");
    expect(grants.value).toBe("tenant-a, tenant-b");
    await blurField(grants);
    expect(grants.getAttribute("aria-invalid")).toBeNull();
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(submitted.jwtNamespaces).toEqual(["tenant-a", "tenant-b"]);
  });

  it("warns before a save that would scope every later static login", async () => {
    currentSettings.jwtNamespaces = ["*"];
    await renderForm();
    const warning = () => host.querySelector('[data-testid="scoped-login-warning"]');
    expect(warning()).toBeNull();

    await change("Namespace grants", "tenant-a");
    expect(warning()?.textContent).toContain("cannot change BFF settings");

    await change("Namespace grants", "*");
    expect(warning()).toBeNull();
    await change("Namespace grants", "tenant-a, bad grant");
    expect(warning()).toBeNull();
  });

  it("keeps an invalid grant visible with an inline error and does not save", async () => {
    await renderForm();
    const grants = inputByLabel("Namespace grants");
    await clearText(grants);
    await typeText(grants, "tenant-a, bad grant");
    await blurField(grants);
    expect(grants.value).toBe("tenant-a, bad grant");
    expect(grants.getAttribute("aria-invalid")).toBe("true");
    const description = document.getElementById(grants.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain('("bad grant")');

    await save();
    expect(put).not.toHaveBeenCalled();
    expect(grants.value).toBe("tenant-a, bad grant");
  });

  it("omits an untouched every-namespace grant so the server keeps it", async () => {
    currentSettings.jwtNamespaces = ["*"];
    await renderForm();
    expect(inputByLabel("Namespace grants").value).toBe("*");
    await change("JWT Issuer", "issuer-2");
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({ jwtIssuer: "issuer-2", jwtRole: "admin" });
    expect(submitted).not.toHaveProperty("jwtNamespaces");
  });

  it("leaves untouched multi-namespace grants out of an unrelated save", async () => {
    currentSettings.jwtNamespaces = ["tenant-a", "tenant-b"];
    savedSettings = { ...currentSettings, jwtIssuer: "issuer-2" };
    await renderForm();
    await change("JWT Issuer", "issuer-2");
    await change("Namespace grants", "tenant-b, tenant-a");
    await change("Namespace grants", "tenant-a, tenant-b");
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({ jwtIssuer: "issuer-2", jwtRole: "admin" });
    expect(submitted).not.toHaveProperty("jwtNamespaces");
    expect(toast).toHaveBeenCalledWith("success", "Settings saved successfully");
  });

  it.each([
    ["Runtime settings are disabled", "FERRUM_BFF_SETTINGS_IMMUTABLE"],
    ["Namespace-scoped sessions cannot change BFF settings", "FERRUM_BFF_SETTINGS_NAMESPACE_SCOPED"],
  ])("reports a refused save once, with the server's reason: %s (#464)", async (reason, code) => {
    put.mockImplementation(() => ({
      json: async () => {
        throw Object.assign(new Error("Forbidden"), {
          response: { status: 403 },
          data: { error: reason, code },
        });
      },
    }));
    await renderForm();
    await change("JWT Issuer", "issuer-2");
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith("error", `Forbidden: ${reason}`);
    expect(inputByLabel("Namespace grants").getAttribute("aria-invalid")).toBeNull();
    expect(inputByLabel("JWT Issuer").value).toBe("issuer-2");
    // The toast is the only report: the global popup is told the caller
    // handles a 403 on this request.
    expect(put.mock.calls[0][1]).toMatchObject({ context: { handledStatuses: [403] } });
  });

  it("treats reordered or respaced grants as untouched (#464)", async () => {
    currentSettings.jwtNamespaces = ["tenant-a", "tenant-b"];
    savedSettings = { ...currentSettings, jwtIssuer: "issuer-2" };
    await renderForm();
    await change("JWT Issuer", "issuer-2");
    await change("Namespace grants", "tenant-b,tenant-a, tenant-b");
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({ jwtIssuer: "issuer-2" });
    expect(submitted).not.toHaveProperty("jwtNamespaces");
  });

  it.each([
    ["", "Enter at least one namespace, or * for every namespace"],
    [" , ", "Enter at least one namespace, or * for every namespace"],
    ["*, tenant-a", "* grants every namespace and cannot be combined with names"],
  ])("refuses grant text %j instead of saving an unrestricted scope", async (text, message) => {
    await renderForm();
    const grants = inputByLabel("Namespace grants");
    await change("Namespace grants", text);
    await blurField(grants);
    expect(grants.getAttribute("aria-invalid")).toBe("true");
    const description = document.getElementById(grants.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain(message);

    await save();
    expect(put).not.toHaveBeenCalled();
    expect(grants.value).toBe(text);
  });

  it("clears and retypes numeric settings without inserting 0 (#402)", async () => {
    await renderForm();
    const ttl = inputByLabel("JWT TTL (seconds)");
    await clearText(ttl);
    expect(ttl.value).toBe("");
    await save();
    expect(put).not.toHaveBeenCalled();
    expect(ttl.value).toBe("");
    expect(ttl.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("JWT TTL is required");

    await typeText(ttl, "1200");
    const read = inputByLabel("Read Timeout (ms)");
    await clearText(read);
    expect(read.value).toBe("");
    await typeText(read, "45000");
    await save();

    expect(put).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({
      jwtTtl: 1200,
      connectTimeout: 5000,
      readTimeout: 45000,
      writeTimeout: 60000,
    });
  });
});

describe("SettingsForm failed reads", () => {
  function failRead(error: unknown) {
    get.mockImplementation(() => ({
      json: async () => {
        throw error;
      },
    }));
  }

  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === text,
    );
  }

  it("renders a persistent read error instead of invented defaults on an initial failure", async () => {
    failRead(new Error("network"));
    await renderForm();

    expect(host.textContent).toContain("Unable to load settings");
    expect(host.textContent).toContain("Retry");
    expect(host.textContent).not.toContain("Save Settings");
    expect(host.textContent).not.toContain(
      "Connection and signing settings are immutable",
    );
    expect(
      Array.from(host.querySelectorAll("label")).some(
        (label) => label.textContent?.trim() === "Admin URL",
      ),
    ).toBe(false);
  });

  it("adopts a successful retry and shows Save according to the observed flag", async () => {
    get.mockImplementationOnce(() => ({
      json: () => Promise.reject(new Error("network")),
    }));
    await renderForm();
    expect(host.textContent).toContain("Unable to load settings");

    const retryButton = findButton("Retry");
    expect(retryButton).toBeDefined();
    await act(async () => retryButton!.click());

    expect(inputByLabel("Admin URL").value).toBe("http://127.0.0.1:9000");
    expect(host.textContent).toContain("Save Settings");
  });

  it("restores the read-only explanation when a retry loads an immutable configuration", async () => {
    get.mockImplementationOnce(() => ({
      json: () => Promise.reject(new Error("network")),
    }));
    await renderForm();

    currentSettings.runtimeSettingsEnabled = false;
    const retryButton = findButton("Retry");
    expect(retryButton).toBeDefined();
    await act(async () => retryButton!.click());

    expect(inputByLabel("Admin URL").disabled).toBe(true);
    expect(host.textContent).not.toContain("Save Settings");
    expect(host.textContent).toContain(
      "Connection and signing settings are immutable",
    );
  });

  it("distinguishes a permission denial from unavailable data", async () => {
    failRead(Object.assign(new Error("Forbidden"), { response: { status: 403 } }));
    await renderForm();

    expect(host.textContent).toContain(
      "Connection settings: read not permitted for this session",
    );
    expect(host.textContent).toContain(
      "authorization denial, not missing or empty data",
    );
    expect(host.textContent).not.toContain("Save Settings");
    expect(
      Array.from(host.querySelectorAll("label")).some(
        (label) => label.textContent?.trim() === "Admin URL",
      ),
    ).toBe(false);
    expect(findButton("Retry")).toBeUndefined();
  });
});

describe("SettingsForm connection test", () => {
  // A real ky instance with the app client's GET retry policy (no delay), so
  // the form's own options (status predicate, response hook, body timeout)
  // run as they do in the browser. The BFF relays the gateway's HTTP status
  // with a `{ reachable, status, body }` envelope.
  let fetched: number;
  let settled: Promise<unknown>;

  function serve(respond: () => Response, timeout = 1000) {
    fetched = 0;
    settled = Promise.resolve();
    const client = ky.create({
      prefix: "http://bff.test/",
      timeout,
      retry: { limit: 2, methods: ["get"], statusCodes: [502, 503, 504], delay: () => 0 },
      fetch: async () => {
        fetched += 1;
        return respond();
      },
    });
    get.mockImplementation((path: string, options?: Options) => {
      if (path !== "api/settings/status") return { json: async () => currentSettings };
      const pending = client.get(path, options);
      const json = pending.json.bind(pending);
      pending.json = (() => {
        const read = json();
        settled = read.catch(() => undefined);
        return read;
      }) as typeof pending.json;
      return pending;
    });
  }

  function answer(status: number, body: unknown) {
    serve(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  }

  function testButton(): HTMLButtonElement {
    const button = Array.from(host.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === "Test Connection",
    );
    if (!button) throw new Error("Missing Test Connection button");
    return button;
  }

  async function testConnection() {
    await act(async () => {
      testButton().click();
      await settled;
    });
  }

  function badge(): HTMLElement {
    const card = Array.from(host.querySelectorAll("h2")).find(
      (heading) => heading.textContent?.trim() === "Connection Test",
    )?.parentElement;
    const element = card?.querySelector<HTMLElement>(":scope > div > span");
    if (!element) throw new Error("Missing connection test badge");
    return element;
  }

  it("reports a ready gateway as connected", async () => {
    await renderForm();
    answer(200, { reachable: true, status: 200, body: { status: "ok", ready: true } });
    await testConnection();

    expect(badge().textContent).toBe("Connected (HTTP 200)");
    expect(badge().className).toContain("text-success");
  });

  it("reports a gateway answering 503 with its health snapshot as connected but not ready", async () => {
    await renderForm();
    answer(503, {
      reachable: true,
      status: 503,
      body: { status: "unavailable", ready: false, mode: "database" },
    });
    await testConnection();

    expect(badge().textContent).toBe("Connected (HTTP 503), gateway not ready: unavailable");
    expect(badge().className).toContain("text-warning");
    // A 503 is an answer: never retried.
    expect(fetched).toBe(1);
  });

  it.each([
    ["an error object", { error: "upstream connect error" }],
    ["a text page", "<html>503 Service Unavailable</html>"],
  ])("keeps a non-health 503 carrying %s unreachable", async (_label, body) => {
    await renderForm();
    answer(503, { reachable: false, status: 503, body });
    await testConnection();

    expect(badge().textContent).toBe("Not reachable (HTTP 503)");
    expect(badge().className).toContain("text-danger");
  });

  it.each([
    ["no envelope", "<html>503</html>"],
    ["an empty body", ""],
    ["a bare reachable claim", { reachable: true }],
    ["a reachable claim without a health snapshot", { reachable: true, status: 503 }],
    ["a reachable claim with an error body", { reachable: true, status: 503, body: { error: "down" } }],
    ["an envelope naming another status", { reachable: true, status: 200, body: { status: "ok", ready: true } }],
  ])("reports a 503 with %s as a failed test", async (_label, body) => {
    await renderForm();
    answer(503, body);
    await testConnection();

    expect(badge().textContent).toBe("Connection test failed (HTTP 503)");
    expect(badge().className).toContain("text-danger");
  });

  it("reports a 200 whose envelope names another status as a failed test", async () => {
    await renderForm();
    answer(200, { reachable: true });
    await testConnection();

    expect(badge().textContent).toBe("Connection test failed (HTTP 200)");
  });

  it("still retries and throws any other failing status", async () => {
    await renderForm();
    answer(502, { reachable: false, code: "FERRUM_BFF_UPSTREAM_FAILURE" });
    await testConnection();

    expect(fetched).toBe(3);
    expect(badge().textContent).toContain("502");
    expect(badge().className).toContain("text-danger");
  });

  it.each([200, 503])("bounds a %s answer whose body never completes", async (status) => {
    await renderForm();
    serve(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"reachable":'));
      },
    }), { status }), 50);
    await testConnection();

    expect(testButton().disabled).toBe(false);
    expect(badge().textContent).toContain("timed out");
    expect(badge().className).toContain("text-danger");
  });
});
