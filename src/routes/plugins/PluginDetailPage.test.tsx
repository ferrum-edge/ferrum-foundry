import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, Proxy } from "@/api/types";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import PluginDetailPage from "./$pluginId";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    proxyApi: { get },
  };
});
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({
    selectedNamespace: "default",
    scope: { namespace: "default" },
    setNamespace: () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ pluginId: "group-1" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plugin: PluginConfig = {
  id: "group-1",
  plugin_name: "rate_limiting",
  scope: "proxy_group",
  config: {},
  enabled: true,
  created_at: "2026-09-05T00:00:00Z",
  updated_at: "2026-09-05T00:00:00Z",
};

function member(id: string): Proxy {
  return {
    id,
    listen_path: `/${id}`,
    backend_scheme: "http",
    backend_host: "localhost",
    backend_port: 8080,
    hosts: [],
    strip_listen_path: false,
    preserve_host_header: false,
    backend_connect_timeout_ms: 5000,
    backend_read_timeout_ms: 5000,
    backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    plugins: [{ plugin_config_id: plugin.id }],
    created_at: plugin.created_at,
    updated_at: plugin.updated_at,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function page(data: Proxy[], offset = 0, total = data.length) {
  return { data, pagination: { offset, limit: 250, total } };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let pluginResponse: ReturnType<typeof deferred<PluginConfig>>;
let firstPage: ReturnType<typeof deferred<ReturnType<typeof page>>>;
let secondPage: ReturnType<typeof deferred<ReturnType<typeof page>>>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  get.mockReset();
  pluginResponse = deferred<PluginConfig>();
  firstPage = deferred<ReturnType<typeof page>>();
  secondPage = deferred<ReturnType<typeof page>>();
  get.mockImplementation((path, options) => ({
    json: () => {
      if (path === "plugins") return Promise.resolve(["rate_limiting"]);
      if (path === "plugins/config/group-1") return pluginResponse.promise;
      if (path === "proxies") {
        return options.searchParams.offset === "0"
          ? firstPage.promise
          : secondPage.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  }));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function render(ui: ReactElement = <PluginDetailPage />) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

function selectedIds() {
  return Array.from(
    host.querySelectorAll("button[aria-label^='Remove ']"),
  ).map((button) => button.getAttribute("aria-label"));
}

async function chooseScope(label: string) {
  const trigger = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find((entry) =>
    document.getElementById(entry.getAttribute("aria-labelledby") ?? "")?.textContent === "Scope",
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === label)!;
  expect(option).toBeTruthy();
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

describe("proxy group membership loading", () => {
  it.each(["plugin first", "proxies first"])("waits for both: %s", async (order) => {
    await render();
    expect(host.querySelector("form")).toBeNull();
    if (order === "plugin first") pluginResponse.resolve(plugin);
    else firstPage.resolve(page([member("source")]));
    await settle();
    expect(host.querySelector("form")).toBeNull();

    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();
    expect(host.querySelector("form")).not.toBeNull();
    expect(selectedIds()).toEqual(["Remove /source"]);
  });

  it("waits for every listAll page before mounting the picker", async () => {
    await render();
    for (const path of ["plugins", "plugins/config/group-1"]) {
      expect(get).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          headers: { "X-Ferrum-Namespace": "default" },
        }),
      );
    }
    expect(get).toHaveBeenCalledWith("proxies", {
      searchParams: { offset: "0", limit: "250" },
      headers: { "X-Ferrum-Namespace": "default" },
    });
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")], 0, 2));
    await settle();
    expect(get).toHaveBeenCalledWith("proxies", {
      searchParams: { offset: "1", limit: "250" },
      headers: { "X-Ferrum-Namespace": "default" },
    });
    expect(host.querySelector("form")).toBeNull();
    secondPage.resolve(page([member("destination")], 1, 2));
    await settle();
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);
  });

  it.each([false, true])("shows a list error (later page: %s)", async (laterPage) => {
    await render();
    pluginResponse.resolve(plugin);
    if (laterPage) {
      firstPage.resolve(page([member("source")], 0, 2));
      await settle();
      secondPage.reject(new Error("List failed"));
    } else {
      firstPage.reject(new Error("List failed"));
    }
    await settle();
    expect(host.textContent).toContain("Failed to load proxy group membership");
    expect(host.querySelector("form")).toBeNull();
    expect(
      host.querySelector("input[placeholder='Search proxies to add...']"),
    ).toBeNull();
  });

  it("does not block a global plugin on the proxy list", async () => {
    await render();
    pluginResponse.resolve({ ...plugin, scope: "global" });
    firstPage.reject(new Error("List failed"));
    await settle();
    expect(host.querySelector("form")).not.toBeNull();
  });

  it("preserves picker edits when the detail page receives refreshed membership", async () => {
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("destination")]));
    await settle();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>("button[aria-label='Remove /source']")
        ?.click();
    });
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [
        member("source"),
        { ...member("destination"), plugins: [] },
      ]);
    });
    await settle();
    expect(selectedIds()).toEqual(["Remove /destination"]);
  });

  it("initializes late form membership once and preserves later user edits", async () => {
    client.setQueryData(["proxies", "default", "all"], [
      member("source"),
      member("destination"),
    ]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const form = (ids: string[], loaded: boolean, data = plugin) => (
      <PluginConfigForm
        initialData={data}
        initialProxyGroupIds={ids}
        initialProxyGroupIdsLoaded={loaded}
        availablePlugins={["rate_limiting"]}
        isLoading={false}
        onSubmit={onSubmit}
      />
    );
    await render(form([], false));
    await render(form(["source", "destination"], true));
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>("button[aria-label='Remove /source']")
        ?.click();
    });
    await render(form(["source", "destination"], true));
    expect(selectedIds()).toEqual(["Remove /destination"]);
    await act(async () => {
      host.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "proxy_group" }),
      ["destination"],
    );
    await render(form(["source"], true, { ...plugin, id: "group-2" }));
    expect(selectedIds()).toEqual(["Remove /source"]);
  });
  it("preserves loaded edit membership across a scope round trip and submits it unchanged", async () => {
    client.setQueryData(["proxies", "default", "all"], [member("source"), member("destination")]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(<PluginConfigForm initialData={plugin} initialProxyGroupIds={["source", "destination"]} availablePlugins={["rate_limiting"]} isLoading={false} onSubmit={onSubmit} />);
    await chooseScope("Global");
    expect(selectedIds()).toEqual([]);
    await chooseScope("Proxy Group");
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ scope: "proxy_group" }), ["source", "destination"]);
  });

  it("keeps a missing selected member visible until explicitly removed", async () => {
    client.setQueryData(["proxies", "default", "all"], [member("source"), member("destination")]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(<PluginConfigForm initialData={plugin} initialProxyGroupIds={["source", "destination"]} availablePlugins={["rate_limiting"]} isLoading={false} onSubmit={onSubmit} />);
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [member("source")]);
    });
    await settle();
    expect(selectedIds()).toEqual(["Remove /source", "Remove destination (not in current catalog)"]);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove destination (not in current catalog)"]')!.click();
    });
    expect(selectedIds()).toEqual(["Remove /source"]);
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ scope: "proxy_group" }), ["source"]);
  });

  it("keeps create-mode scope resets explicit and unchanged", async () => {
    client.setQueryData(["proxies", "default", "all"], [member("source")]);
    await render(<PluginConfigForm defaults={{ scope: "proxy_group", pluginName: "rate_limiting", proxyGroupIds: ["source"] }} availablePlugins={["rate_limiting"]} isLoading={false} onSubmit={vi.fn()} />);
    expect(selectedIds()).toEqual(["Remove /source"]);
    await chooseScope("Global");
    await chooseScope("Proxy Group");
    expect(selectedIds()).toEqual([]);
  });

});
