import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, Proxy } from "@/api/types";
import { PluginConfigForm } from "@/components/forms/PluginConfigForm";
import {
  DEFER_QUERY_ERRORS,
  markCommittedWrite,
  reportRequestError,
  SILENT_ERRORS,
} from "@/api/client";
import { ErrorPopupProvider } from "@/stores/error";
import { PluginMembershipChangedError } from "@/lib/pluginMembership";
import { pluginWriteGuard, toBaseline } from "@/api/plugins";
import { StaleResourceError } from "@/api/conditionalWrite";
import PluginDetailPage from "./$pluginId";

const { get, updatePlan, deletePlan, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  updatePlan: vi.fn(),
  deletePlan: vi.fn(),
  toast: vi.fn(),
}));

// The membership plans themselves are covered in `src/lib`; here only what
// the page hands them matters.
vi.mock("@/lib/pluginMembership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pluginMembership")>();
  return {
    ...actual,
    updatePluginWithMembership: updatePlan,
    deletePluginWithMembership: deletePlan,
  };
});

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
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast }),
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
  // A page may be rejected before the query that reads it has started.
  promise.catch(() => undefined);
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
/** The plugin catalog (`GET /plugins`); resolved unless a test holds it back. */
let catalog: Promise<string[]>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  get.mockReset();
  updatePlan.mockReset();
  deletePlan.mockReset();
  toast.mockReset();
  pluginResponse = deferred<PluginConfig>();
  firstPage = deferred<ReturnType<typeof page>>();
  secondPage = deferred<ReturnType<typeof page>>();
  catalog = Promise.resolve(["rate_limiting"]);
  get.mockImplementation((path, options) => ({
    headers: new Headers(),
    json: () => {
      if (path === "plugins") return catalog;
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
  it.each(["global", "proxy"] as const)("does not traverse proxies for a %s-scoped plugin", async (scope) => {
    await render();
    pluginResponse.resolve({ ...plugin, scope, ...(scope === "proxy" && { proxy_id: "source" }) });
    await settle();
    await settle();
    expect(host.querySelector("form")).not.toBeNull();
    // A proxy-scoped plugin's picker reads its own bounded first page; the
    // whole-collection membership traversal must never start.
    const all = client.getQueryState(["proxies", "default", "all"]);
    expect(all?.data).toBeUndefined();
    expect(all?.fetchStatus ?? "idle").toBe("idle");
    if (scope === "global") expect(get).not.toHaveBeenCalledWith("proxies", expect.anything());
  });

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
          headers: expect.objectContaining({ "X-Ferrum-Namespace": "default" }),
        }),
      );
    }
    // Membership is read only once the plugin proves to be group-scoped.
    expect(get).not.toHaveBeenCalledWith("proxies", expect.anything());
    pluginResponse.resolve(plugin);
    await settle();
    expect(get).toHaveBeenCalledWith("proxies", expect.objectContaining({
      searchParams: { offset: "0", limit: "250" },
      headers: { "X-Ferrum-Namespace": "default" },
      context: { deferQueryErrors: true },
    }));
    firstPage.resolve(page([member("source")], 0, 2));
    await settle();
    expect(get).toHaveBeenCalledWith("proxies", expect.objectContaining({
      searchParams: { offset: "1", limit: "250" },
      headers: { "X-Ferrum-Namespace": "default" },
      context: { deferQueryErrors: true },
    }));
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
    expect(host.textContent).toContain("Proxy group membership unavailable");
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

  it("says only 'unavailable' when a selected member's read fails for another reason", async () => {
    client.setQueryData(["proxies", "default", "all"], [member("source")]);
    get.mockImplementation((path: string) => ({
      headers: new Headers(),
      json: () =>
        path === "proxies/destination"
          ? Promise.reject(Object.assign(new Error("Service Unavailable"), { response: { status: 503 } }))
          : Promise.reject(new Error(`Unexpected request: ${path}`)),
    }));
    await render(<PluginConfigForm initialData={plugin} initialProxyGroupIds={["source", "destination"]} availablePlugins={["rate_limiting"]} isLoading={false} onSubmit={vi.fn()} />);
    await settle();
    // A 503 says nothing about whether the proxy exists; it must not be
    // reported as a deletion.
    expect(selectedIds()).toEqual(["Remove /source", "Remove destination (label unavailable)"]);
  });

  it("keeps a missing selected member visible until explicitly removed", async () => {
    get.mockImplementation((path: string) => ({
      headers: new Headers(),
      json: () =>
        path === "proxies/destination"
          ? Promise.reject(Object.assign(new Error("Not Found"), { response: { status: 404 } }))
          : Promise.reject(new Error(`Unexpected request: ${path}`)),
    }));
    client.setQueryData(["proxies", "default", "all"], [member("source"), member("destination")]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(<PluginConfigForm initialData={plugin} initialProxyGroupIds={["source", "destination"]} availablePlugins={["rate_limiting"]} isLoading={false} onSubmit={onSubmit} />);
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [member("source")]);
    });
    await settle();
    // The picker no longer downloads the collection to name a selection, so a
    // member outside the loaded catalog is resolved by id. Here that read is
    // refused, and the selection stays visible and removable either way (#382).
    await settle();
    expect(selectedIds()).toEqual([
      "Remove /source",
      "Remove destination (no longer on the gateway)",
    ]);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove destination (no longer on the gateway)"]')!.click();
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

describe("the membership a save or delete expects (#630)", () => {
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  it("saves with the membership the form was seeded with, then the one it saved", async () => {
    updatePlan.mockResolvedValue(plugin);
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("destination")]));
    await settle();
    // A background refetch picks up a proxy another operator attached. The
    // form is not reseeded, so the operator never saw it.
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [
        member("source"),
        member("destination"),
        member("late"),
      ]);
    });
    await settle();
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>("button[aria-label='Remove /destination']")
        ?.click();
    });
    await submit();
    expect(updatePlan).toHaveBeenCalledTimes(1);
    expect(updatePlan.mock.calls[0]![2]).toEqual(["source"]);
    expect(updatePlan.mock.calls[0]![5]).toEqual(["source", "destination"]);

    // The accepted save is what the form now shows.
    await submit();
    expect(updatePlan).toHaveBeenCalledTimes(2);
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source"]);
  });

  it("deletes with the membership the page showed, not a later refetch", async () => {
    deletePlan.mockResolvedValue(undefined);
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [member("source"), member("late")]);
    });
    await settle();

    const open = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete")!;
    expect(open).toBeTruthy();
    await act(async () => open.click());
    await settle();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete Plugin")!;
    expect(confirm).toBeTruthy();
    await act(async () => confirm.click());
    await settle();

    expect(deletePlan).toHaveBeenCalledTimes(1);
    expect(deletePlan.mock.calls[0]![0]).toBe("group-1");
    expect(deletePlan.mock.calls[0]![3]).toEqual(["source"]);
  });

  it("takes the membership from the form that mounted, not a read from before it", async () => {
    // The plugin catalog is slow, so the page shows a skeleton after the
    // plugin and its membership have loaded.
    const slowCatalog = deferred<string[]>();
    catalog = slowCatalog.promise;
    deletePlan.mockResolvedValue(undefined);
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("destination")]));
    await settle();
    expect(host.querySelector("form")).toBeNull();
    // A refetch shows destination detached before the form ever appears.
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [
        member("source"),
        { ...member("destination"), plugins: [] },
      ]);
    });
    await settle();
    slowCatalog.resolve(["rate_limiting"]);
    await settle();
    expect(host.querySelector("form")).not.toBeNull();
    expect(selectedIds()).toEqual(["Remove /source"]);
    // Then another operator reattaches destination; the form does not show it.
    await act(async () => {
      client.setQueryData(["proxies", "default", "all"], [
        member("source"),
        member("destination"),
      ]);
    });
    await settle();
    expect(selectedIds()).toEqual(["Remove /source"]);

    const open = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete")!;
    await act(async () => open.click());
    await settle();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Delete Plugin")!;
    await act(async () => confirm.click());
    await settle();

    // Only what the operator saw: a read from before the form mounted would
    // have expected destination too, and the delete would detach it unseen.
    expect(deletePlan).toHaveBeenCalledTimes(1);
    expect(deletePlan.mock.calls[0]![3]).toEqual(["source"]);
  });
});

describe("a plugin save that committed but is not yet live (#674)", () => {
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  it("reseeds the form, membership and baseline from fresh reads and warns", async () => {
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("destination")]));
    await settle();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>("button[aria-label='Remove /destination']")
        ?.click();
    });

    // The gateway commits the save, then answers with the committed `503`.
    // From here on it holds the operator's own committed configuration.
    const saved: PluginConfig = { ...plugin, config: { requests: 5 }, updated_at: "2026-09-06T00:00:00Z" };
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(saved);
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.resolve(page([member("source"), { ...member("destination"), plugins: [] }]));
    updatePlan.mockRejectedValueOnce(
      markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
    );
    await submit();
    await settle();

    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Plugin configuration saved: committed, not yet proven live"),
    );
    expect(toast).not.toHaveBeenCalledWith("error", expect.anything());
    // No recovery report: nothing failed.
    expect(host.textContent).not.toContain("did not converge");
    expect(selectedIds()).toEqual(["Remove /source"]);

    // The next save is judged against what the gateway now holds, with the
    // membership the reseeded form shows, not refused as a conflict with
    // this operator's own commit.
    updatePlan.mockResolvedValueOnce(saved);
    await submit();
    expect(updatePlan).toHaveBeenCalledTimes(2);
    expect(updatePlan.mock.calls[1]![4]).toEqual(pluginWriteGuard(saved));
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source"]);
  });
});

describe("discarding a draft after a refused write (#726)", () => {
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  function stale(current: PluginConfig): StaleResourceError {
    return new StaleResourceError({
      resource: "plugin configuration",
      operation: "save",
      id: plugin.id,
      namespace: "default",
      original: toBaseline(plugin),
      current: toBaseline(current),
      proposed: toBaseline(plugin),
    });
  }

  function dialogButton(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === label);
  }

  async function click(label: string) {
    const button = dialogButton(label);
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    await settle();
  }

  function reads(path: string) {
    return get.mock.calls.filter(([called]) => called === path).length;
  }

  /** Open a group plugin, remove a member, and have the save refused. */
  async function refusedGroupDraft(current: PluginConfig) {
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("destination")]));
    await settle();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>("button[aria-label='Remove /destination']")
        ?.click();
    });
    updatePlan.mockRejectedValueOnce(stale(current));
    await submit();
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();
    expect(selectedIds()).toEqual(["Remove /source"]);
  }

  it("re-reads the plugin and its membership before remounting the form", async () => {
    const current: PluginConfig = { ...plugin, config: { requests: 9 }, updated_at: "2026-09-06T00:00:00Z" };
    await refusedGroupDraft(current);
    const draftForm = host.querySelector("form");
    const pluginReads = reads("plugins/config/group-1");
    const proxyReads = reads("proxies");

    // Another operator also attached `late` since the page loaded.
    pluginResponse = deferred<PluginConfig>();
    firstPage = deferred<ReturnType<typeof page>>();
    await click("Discard my draft and reload");
    pluginResponse.resolve(current);
    await settle();
    // The plugin is read, but nothing is remounted while its membership loads.
    expect(reads("plugins/config/group-1")).toBe(pluginReads + 1);
    expect(reads("proxies")).toBe(proxyReads + 1);
    expect(host.querySelector("form")).toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);

    firstPage.resolve(page([member("source"), member("destination"), member("late")]));
    await settle();
    expect(host.querySelector("form")).not.toBe(draftForm);
    // `late` is selected; its label resolves from the picker's own catalog.
    expect(selectedIds()).toEqual([
      "Remove /source",
      "Remove /destination",
      expect.stringContaining("late"),
    ]);
    expect(dialogButton("Discard my draft and reload")).toBeUndefined();
    expect(toast).not.toHaveBeenCalledWith("error", expect.anything());

    // The next save is judged against the fresh plugin and expects the
    // membership the remounted form shows.
    updatePlan.mockResolvedValueOnce(current);
    await submit();
    expect(updatePlan).toHaveBeenCalledTimes(2);
    expect(updatePlan.mock.calls[1]![4]).toEqual(pluginWriteGuard(current));
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source", "destination", "late"]);
  });

  /**
   * Open a global plugin and have its save refused because another operator
   * made it a group. The gateway already answers with the group, so the
   * save's settle invalidation refetches it and the page learns the new scope
   * while the draft and the dialog are on screen.
   */
  async function refusedScopeChange(current: PluginConfig) {
    await render();
    pluginResponse.resolve({ ...plugin, scope: "global" });
    await settle();
    await settle();
    const draftForm = host.querySelector("form");
    expect(draftForm).not.toBeNull();
    expect(get).not.toHaveBeenCalledWith("proxies", expect.anything());

    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(current);
    updatePlan.mockRejectedValueOnce(stale(current));
    await submit();
    await settle();
    // The refetch saw the group. Neither the skeleton nor the membership
    // error replaced the form, and the background membership traversal did
    // not start: the mounted form cannot show it, and only an explicit
    // reload reads it.
    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toEqual(current);
    expect(get).not.toHaveBeenCalledWith("proxies", expect.anything());
    expect(host.querySelector("form")).toBe(draftForm);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();
    return draftForm;
  }

  it("reads the membership of a plugin whose scope changed to proxy_group", async () => {
    const current: PluginConfig = { ...plugin, updated_at: "2026-09-06T00:00:00Z" };
    firstPage = deferred<ReturnType<typeof page>>();
    const draftForm = await refusedScopeChange(current);

    await click("Discard my draft and reload");
    expect(host.querySelector("form")).toBe(draftForm);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();

    firstPage.resolve(page([member("source")]));
    await settle();
    expect(host.querySelector("form")).not.toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
    expect(dialogButton("Discard my draft and reload")).toBeUndefined();

    updatePlan.mockResolvedValueOnce(current);
    await submit();
    expect(updatePlan.mock.calls[1]![4]).toEqual(pluginWriteGuard(current));
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source"]);
  });

  it("keeps the draft of a plugin whose scope changed when its membership cannot be read", async () => {
    // Exercise the real reporting path: requests report failures as the ky
    // client does (silent, deferred to the Query, or at once), and the
    // global popup provider is mounted.
    const failing = vi.fn();
    get.mockImplementation((path, options) => ({
      headers: new Headers(),
      json: () => {
        if (path === "plugins") return catalog;
        if (path === "plugins/config/group-1") return pluginResponse.promise;
        if (path === "proxies") {
          failing();
          const error = new Error("HTTP 503");
          const context = options.context ?? {};
          if (!context[SILENT_ERRORS]) {
            reportRequestError(
              error,
              { statusCode: 503, body: "unavailable", url: "/api/proxy/proxies" },
              Boolean(context[DEFER_QUERY_ERRORS]),
            );
          }
          return Promise.reject(error);
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    }));
    const current: PluginConfig = { ...plugin, updated_at: "2026-09-06T00:00:00Z" };
    await render(
      <ErrorPopupProvider>
        <PluginDetailPage />
      </ErrorPopupProvider>,
    );
    pluginResponse.resolve({ ...plugin, scope: "global" });
    await settle();
    await settle();
    const draftForm = host.querySelector("form");
    expect(draftForm).not.toBeNull();
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(current);
    updatePlan.mockRejectedValueOnce(stale(current));
    await submit();
    await settle();
    expect(failing).not.toHaveBeenCalled();

    await click("Discard my draft and reload");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "error",
      "Could not re-read the plugin's proxies; your form was kept. Try again.",
    );
    // Only the toast: no API Error popup over the conflict dialog.
    expect(document.body.textContent).not.toContain("API Error");
    expect(host.querySelector("form")).toBe(draftForm);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();
  });

  it("shows only the reload toast when a mounted group's membership refresh fails too", async () => {
    // Real reporting path, as above. The group loads (two proxy pages); then
    // its second page starts failing for the save's settle refresh and for
    // the explicit reload alike.
    let laterPagesFail = false;
    get.mockImplementation((path, options) => ({
      headers: new Headers(),
      json: () => {
        if (path === "plugins") return catalog;
        if (path === "plugins/config/group-1") return pluginResponse.promise;
        if (path === "proxies") {
          if (options.searchParams.offset === "0") {
            return Promise.resolve(page([member("source")], 0, 2));
          }
          if (!laterPagesFail) return Promise.resolve(page([member("destination")], 1, 2));
          const error = new Error("HTTP 503");
          const context = options.context ?? {};
          if (!context[SILENT_ERRORS]) {
            reportRequestError(
              error,
              { statusCode: 503, body: "unavailable", url: "/api/proxy/proxies" },
              Boolean(context[DEFER_QUERY_ERRORS]),
            );
          }
          return Promise.reject(error);
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    }));
    await render(
      <ErrorPopupProvider>
        <PluginDetailPage />
      </ErrorPopupProvider>,
    );
    pluginResponse.resolve(plugin);
    await settle();
    await settle();
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);
    const draftForm = host.querySelector("form");

    laterPagesFail = true;
    const current: PluginConfig = { ...plugin, config: { requests: 9 } };
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(current);
    updatePlan.mockRejectedValueOnce(stale(current));
    await submit();
    await click("Discard my draft and reload");
    await settle();

    expect(toast).toHaveBeenCalledWith(
      "error",
      "Could not re-read the plugin's proxies; your form was kept. Try again.",
    );
    // The settle refresh failed as well, but reports inline, not as a popup.
    expect(client.getQueryState(["proxies", "default", "all"])?.status).toBe("error");
    expect(document.body.textContent).not.toContain("API Error");
    expect(host.querySelector("form")).toBe(draftForm);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();
  });

  it("lets a retry reseed the form once the proxies of a now-group plugin can be read", async () => {
    const current: PluginConfig = { ...plugin, updated_at: "2026-09-06T00:00:00Z" };
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.reject(new Error("HTTP 503"));
    const draftForm = await refusedScopeChange(current);

    await click("Discard my draft and reload");
    expect(toast).toHaveBeenCalledWith(
      "error",
      "Could not re-read the plugin's proxies; your form was kept. Try again.",
    );
    expect(host.querySelector("form")).toBe(draftForm);

    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.resolve(page([member("source")]));
    await click("Discard my draft and reload");
    expect(host.querySelector("form")).not.toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
    expect(dialogButton("Discard my draft and reload")).toBeUndefined();
  });

  it("keeps the draft and the conflict when the plugin cannot be re-read", async () => {
    await refusedGroupDraft({ ...plugin, config: { requests: 9 } });
    const draftForm = host.querySelector("form");
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.reject(new Error("HTTP 503"));
    const proxyReads = reads("proxies");

    await click("Discard my draft and reload");

    expect(toast).toHaveBeenCalledWith(
      "error",
      "Could not re-read the plugin; your form was kept. Try again.",
    );
    expect(reads("proxies")).toBe(proxyReads);
    expect(host.querySelector("form")).toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();

    // The operator can still go back to the draft, as it was.
    await click("Keep my draft");
    expect(dialogButton("Discard my draft and reload")).toBeUndefined();
    expect(host.querySelector("form")).toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
  });

  it("keeps the draft and the conflict when the membership cannot be re-read", async () => {
    const current: PluginConfig = { ...plugin, config: { requests: 9 } };
    await refusedGroupDraft(current);
    const draftForm = host.querySelector("form");
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(current);
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.reject(new Error("HTTP 503"));

    await click("Discard my draft and reload");

    expect(toast).toHaveBeenCalledWith(
      "error",
      "Could not re-read the plugin's proxies; your form was kept. Try again.",
    );
    expect(host.querySelector("form")).toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();

    // Not adopted either: a save from the kept draft is still judged
    // against the plugin the editor opened.
    await click("Keep my draft");
    updatePlan.mockResolvedValueOnce(plugin);
    await submit();
    expect(updatePlan.mock.calls[1]![4]).toEqual(pluginWriteGuard(plugin));
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source", "destination"]);
  });

  it("reads silently, since the page reports a failed reload itself", async () => {
    const current: PluginConfig = { ...plugin, config: { requests: 9 } };
    await refusedGroupDraft(current);
    const before = get.mock.calls.length;
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(current);
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.resolve(page([member("source")]));

    await click("Discard my draft and reload");

    const reloadReads = get.mock.calls.slice(before);
    expect(reloadReads.map(([path]) => path)).toEqual(["plugins/config/group-1", "proxies"]);
    for (const [, options] of reloadReads) {
      expect(options.context[SILENT_ERRORS]).toBe(true);
    }
  });

  it("runs one reload at a time, and Keep my draft abandons it", async () => {
    await refusedGroupDraft({ ...plugin, config: { requests: 9 } });
    const draftForm = host.querySelector("form");
    const pluginReads = reads("plugins/config/group-1");
    pluginResponse = deferred<PluginConfig>();

    await click("Discard my draft and reload");
    // Busy while pending: a second click starts nothing.
    expect(dialogButton("Discard my draft and reload")?.disabled).toBe(true);
    await act(async () => dialogButton("Discard my draft and reload")!.click());
    await settle();
    expect(reads("plugins/config/group-1")).toBe(pluginReads + 1);

    await click("Keep my draft");
    expect(dialogButton("Discard my draft and reload")).toBeUndefined();
    const changed: PluginConfig = { ...plugin, config: { requests: 9 }, updated_at: "2026-09-07T00:00:00Z" };
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.resolve(page([member("source")]));
    pluginResponse.resolve(changed);
    await settle();
    await settle();

    // The abandoned reload neither remounts, adopts, nor reports.
    expect(host.querySelector("form")).toBe(draftForm);
    expect(selectedIds()).toEqual(["Remove /source"]);
    expect(toast).not.toHaveBeenCalledWith("error", expect.anything());
    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toEqual(plugin);
    updatePlan.mockResolvedValueOnce(plugin);
    await submit();
    expect(updatePlan.mock.calls[1]![4]).toEqual(pluginWriteGuard(plugin));
    expect(updatePlan.mock.calls[1]![5]).toEqual(["source", "destination"]);
  });

  it("applies and reports nothing once the editor has gone", async () => {
    await refusedGroupDraft({ ...plugin, config: { requests: 9 } });
    pluginResponse = deferred<PluginConfig>();
    await click("Discard my draft and reload");

    await act(async () => root.unmount());
    root = createRoot(host);
    const proxyReads = reads("proxies");
    pluginResponse.resolve({ ...plugin, config: { requests: 9 }, updated_at: "2026-09-07T00:00:00Z" });
    await settle();

    // Not even the abandoned namespace's membership traversal starts.
    expect(reads("proxies")).toBe(proxyReads);
    expect(toast).not.toHaveBeenCalledWith("error", expect.anything());
    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toEqual(plugin);
  });

  it("does not report a failed read once the editor has gone", async () => {
    await refusedGroupDraft({ ...plugin, config: { requests: 9 } });
    pluginResponse = deferred<PluginConfig>();
    await click("Discard my draft and reload");

    await act(async () => root.unmount());
    root = createRoot(host);
    pluginResponse.reject(new Error("HTTP 503"));
    await settle();

    expect(toast).not.toHaveBeenCalledWith("error", expect.anything());
  });
});

describe("a pending reload locks the form and excludes delete (#726)", () => {
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent?.trim() === label);
  }

  async function open() {
    await render();
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();
    expect(selectedIds()).toEqual(["Remove /source"]);
  }

  function locked() {
    return host.querySelector("form fieldset[aria-busy='true']") !== null;
  }

  function stale(current: PluginConfig): StaleResourceError {
    return new StaleResourceError({
      resource: "plugin configuration",
      operation: "save",
      id: plugin.id,
      namespace: "default",
      original: toBaseline(plugin),
      current: toBaseline(current),
      proposed: toBaseline(plugin),
    });
  }

  /** Try to edit (remove the member) and save the mounted form. */
  async function tryEditAndSave() {
    const remove = host.querySelector<HTMLButtonElement>("button[aria-label='Remove /source']")!;
    expect(remove.matches(":disabled")).toBe(true);
    await act(async () => remove.click());
    await settle();
    expect(selectedIds()).toEqual(["Remove /source"]);
    const calls = updatePlan.mock.calls.length;
    await submit();
    expect(updatePlan.mock.calls.length).toBe(calls);
  }

  /** Have a save refused because `late` joined the group, offering the recovery reload. */
  async function refuseForMembership() {
    updatePlan.mockRejectedValueOnce(new PluginMembershipChangedError(plugin.id, "save", ["late"]));
    await submit();
    expect(button("Reload current membership (discards your draft)")).toBeTruthy();
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(plugin);
    firstPage = deferred<ReturnType<typeof page>>();
  }

  it("locks every field and Save while a recovery reload runs", async () => {
    await open();
    await refuseForMembership();
    const before = host.querySelector("form");

    await act(async () => button("Reload current membership (discards your draft)")!.click());
    await settle();
    expect(locked()).toBe(true);
    await tryEditAndSave();

    firstPage.resolve(page([member("source"), member("late")]));
    await settle();
    expect(host.querySelector("form")).not.toBe(before);
    expect(locked()).toBe(false);
    expect(selectedIds()).toEqual(["Remove /source", expect.stringContaining("late")]);
  });

  it("locks every field and Save while a committed save reseeds", async () => {
    await open();
    pluginResponse = deferred<PluginConfig>();
    firstPage = deferred<ReturnType<typeof page>>();
    updatePlan.mockRejectedValueOnce(
      markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
    );
    await submit();
    expect(locked()).toBe(true);
    await tryEditAndSave();

    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();
    expect(locked()).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Plugin configuration saved: committed, not yet proven live"),
    );
  });

  it("blocks Delete during a reload and asks again against the reloaded membership", async () => {
    deletePlan.mockResolvedValue(undefined);
    await open();
    await refuseForMembership();

    await act(async () => button("Reload current membership (discards your draft)")!.click());
    await settle();
    const del = button("Delete")!;
    expect(del.disabled).toBe(true);
    await act(async () => del.click());
    await settle();
    expect(button("Delete Plugin")).toBeUndefined();

    firstPage.resolve(page([member("source"), member("late")]));
    await settle();
    expect(button("Delete")!.disabled).toBe(false);
    await act(async () => button("Delete")!.click());
    await settle();
    await act(async () => button("Delete Plugin")!.click());
    await settle();
    // The confirmation was given with the reloaded membership on screen.
    expect(deletePlan).toHaveBeenCalledTimes(1);
    expect(deletePlan.mock.calls[0]![3]).toEqual(["source", "late"]);
  });

  it("closes an open delete confirmation when a reload starts", async () => {
    deletePlan.mockResolvedValue(undefined);
    await open();
    // The confirmation is opened first; the save that follows commits.
    await act(async () => button("Delete")!.click());
    await settle();
    expect(button("Delete Plugin")).toBeTruthy();
    const save = deferred<PluginConfig>();
    updatePlan.mockReturnValueOnce(save.promise);
    await submit();

    pluginResponse = deferred<PluginConfig>();
    firstPage = deferred<ReturnType<typeof page>>();
    await act(async () => {
      save.reject(
        markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
      );
    });
    await settle();
    expect(button("Delete Plugin")).toBeUndefined();
    expect(button("Delete")!.disabled).toBe(true);

    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source"), member("late")]));
    await settle();
    expect(deletePlan).not.toHaveBeenCalled();
    await act(async () => button("Delete")!.click());
    await settle();
    expect(button("Delete Plugin")).toBeTruthy();
  });

  it("keeps Delete unavailable while a save and its committed reseed can still run", async () => {
    deletePlan.mockResolvedValue({ committed: null });
    await open();
    const save = deferred<PluginConfig>();
    updatePlan.mockReturnValueOnce(save.promise);
    await submit();
    expect(button("Delete")!.disabled).toBe(true);
    await act(async () => button("Delete")!.click());
    await settle();
    expect(button("Delete Plugin")).toBeUndefined();

    pluginResponse = deferred<PluginConfig>();
    firstPage = deferred<ReturnType<typeof page>>();
    await act(async () => {
      save.reject(
        markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
      );
    });
    await settle();
    expect(button("Delete")!.disabled).toBe(true);
    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();

    // Only now can the delete be confirmed, and once it succeeds nothing
    // recreates the detail entry it retired.
    await act(async () => button("Delete")!.click());
    await settle();
    await act(async () => button("Delete Plugin")!.click());
    await settle();
    await settle();
    expect(deletePlan).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toBeUndefined();
  });

  it("refuses a save while a confirmed delete is in flight", async () => {
    const removal = deferred<unknown>();
    deletePlan.mockReturnValueOnce(removal.promise);
    await open();
    await act(async () => button("Delete")!.click());
    await settle();
    await act(async () => button("Delete Plugin")!.click());
    await settle();
    expect(deletePlan).toHaveBeenCalledTimes(1);

    await submit();
    expect(updatePlan).not.toHaveBeenCalled();
    await act(async () => removal.resolve({ committed: null }));
    await settle();
    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toBeUndefined();
  });

  it("closes an open Scope menu and ignores a choice while a save and its reseed run", async () => {
    await open();
    const trigger = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find((entry) =>
      document.getElementById(entry.getAttribute("aria-labelledby") ?? "")?.textContent === "Scope",
    )!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    const globalOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((entry) => entry.textContent === "Global");
    expect(globalOption).toBeTruthy();

    // The save locks the form as soon as it is pending.
    const save = deferred<PluginConfig>();
    updatePlan.mockReturnValueOnce(save.promise);
    await submit();
    expect(locked()).toBe(true);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

    pluginResponse = deferred<PluginConfig>();
    firstPage = deferred<ReturnType<typeof page>>();
    await act(async () => {
      save.reject(
        markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
      );
    });
    await settle();
    expect(locked()).toBe(true);
    // A choice made through the element still in hand changes nothing.
    await act(async () => {
      globalOption!.focus();
      globalOption!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      globalOption!.click();
    });
    await settle();
    expect(trigger.textContent).toContain("Proxy Group");
    expect(selectedIds()).toEqual(["Remove /source"]);

    pluginResponse.resolve(plugin);
    firstPage.resolve(page([member("source")]));
    await settle();
    expect(locked()).toBe(false);
  });

  it("locks edits while a save is pending, then shows what the committed save stored", async () => {
    await open();
    const save = deferred<PluginConfig>();
    updatePlan.mockReturnValueOnce(save.promise);
    await submit();
    expect(locked()).toBe(true);
    await tryEditAndSave();

    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(plugin);
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.resolve(page([member("source"), member("late")]));
    await act(async () => {
      save.reject(
        markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
      );
    });
    await settle();
    expect(locked()).toBe(false);
    expect(selectedIds()).toEqual(["Remove /source", expect.stringContaining("late")]);
  });

  it("names the membership read when a committed save's reseed cannot read the proxies", async () => {
    await open();
    pluginResponse = deferred<PluginConfig>();
    pluginResponse.resolve(plugin);
    firstPage = deferred<ReturnType<typeof page>>();
    firstPage.reject(new Error("HTTP 503"));
    updatePlan.mockRejectedValueOnce(
      markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
    );
    await submit();
    await settle();
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("Foundry could not re-read the plugin's proxies; reload it before saving again."),
    );
    expect(selectedIds()).toEqual(["Remove /source"]);
  });

  it("starts no read when a save commits after the editor has gone", async () => {
    await open();
    const save = deferred<PluginConfig>();
    updatePlan.mockReturnValueOnce(save.promise);
    await submit();
    const pluginReads = () => get.mock.calls.filter(([path]) => path === "plugins/config/group-1").length;
    const before = pluginReads();

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      save.reject(
        markCommittedWrite(new Error("HTTP 503"), { cursor: "1:2", reason: "reload_timeout" }),
      );
    });
    await settle();

    expect(pluginReads()).toBe(before);
    // The commit itself is still reported, with nothing about a re-read.
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.not.stringContaining("could not re-read"),
    );
  });

  it("aborts the reload's plugin read when the operator keeps the draft", async () => {
    await open();
    updatePlan.mockRejectedValueOnce(stale({ ...plugin, config: { requests: 9 } }));
    await submit();
    pluginResponse = deferred<PluginConfig>();
    await act(async () => button("Discard my draft and reload")!.click());
    await settle();
    const read = get.mock.calls.filter(([path]) => path === "plugins/config/group-1").at(-1)!;
    const signal = read[1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await act(async () => button("Keep my draft")!.click());
    await settle();
    expect(signal.aborted).toBe(true);
  });

  it("stops the membership traversal once a group is saved to another scope", async () => {
    await open();
    const allKey = ["proxies", "default", "all"];
    expect(client.getQueryCache().find({ queryKey: allKey, exact: true })?.isActive()).toBe(true);

    await chooseScope("Global");
    updatePlan.mockResolvedValueOnce({ ...plugin, scope: "global" });
    await submit();
    expect(updatePlan.mock.calls[0]![1]).toMatchObject({ scope: "global" });
    await settle();

    expect(client.getQueryCache().find({ queryKey: allKey, exact: true })?.isActive()).toBe(false);
    const before = get.mock.calls.filter(([path]) => path === "proxies").length;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["proxies"] });
    });
    await settle();
    expect(get.mock.calls.filter(([path]) => path === "proxies").length).toBe(before);
  });
});

describe("a mounted editor reports its background reads inline (#726)", () => {
  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  function dialogButton(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === label);
  }

  function stale(current: PluginConfig): StaleResourceError {
    return new StaleResourceError({
      resource: "plugin configuration",
      operation: "save",
      id: plugin.id,
      namespace: "default",
      original: toBaseline(plugin),
      current: toBaseline(current),
      proposed: toBaseline(plugin),
    });
  }

  /** Fail as the ky client does: silent, deferred to the Query, or at once. */
  function failing(path: string, options: { context?: Record<string, unknown> }) {
    const error = new Error("HTTP 503");
    const context = options.context ?? {};
    if (!context[SILENT_ERRORS]) {
      reportRequestError(
        error,
        { statusCode: 503, body: "unavailable", url: `/api/proxy/${path}` },
        Boolean(context[DEFER_QUERY_ERRORS]),
      );
    }
    return Promise.reject(error);
  }

  /**
   * A gateway that serves the group and two proxy pages until `fail` names a
   * read, after which that read fails for every request.
   */
  function gateway() {
    const state = {
      plugin: plugin as PluginConfig,
      fail: new Set<"plugin" | "firstPage" | "laterPage">(),
    };
    get.mockImplementation((path, options) => ({
      headers: new Headers(),
      json: () => {
        if (path === "plugins") return catalog;
        if (path === "plugins/config/group-1") {
          return state.fail.has("plugin") ? failing(path, options) : Promise.resolve(state.plugin);
        }
        if (path === "proxies") {
          const first = options.searchParams.offset === "0";
          if (state.fail.has(first ? "firstPage" : "laterPage")) return failing(path, options);
          return Promise.resolve(
            first ? page([member("source")], 0, 2) : page([member("destination")], 1, 2),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    }));
    return state;
  }

  async function mountGroup() {
    await render(
      <ErrorPopupProvider>
        <PluginDetailPage />
      </ErrorPopupProvider>,
    );
    await settle();
    await settle();
    expect(selectedIds()).toEqual(["Remove /source", "Remove /destination"]);
    return host.querySelector("form");
  }

  it.each([
    ["the plugin read", "plugin", "Could not re-read the plugin; your form was kept. Try again."],
    ["the first proxy page", "firstPage", "Could not re-read the plugin's proxies; your form was kept. Try again."],
  ] as const)("shows only the reload toast when %s fails for the settle refresh and the reload", async (_label, read, message) => {
    const state = gateway();
    const draftForm = await mountGroup();

    state.fail.add(read);
    updatePlan.mockRejectedValueOnce(stale({ ...plugin, config: { requests: 9 } }));
    await submit();
    await settle();
    await act(async () => dialogButton("Discard my draft and reload")!.click());
    await settle();
    await settle();

    expect(toast).toHaveBeenCalledWith("error", message);
    expect(document.body.textContent).not.toContain("API Error");
    expect(host.querySelector("form")).toBe(draftForm);
    expect(dialogButton("Discard my draft and reload")).toBeTruthy();
  });

  it("keeps the membership notice for the displayed group when a refetch says Global", async () => {
    const state = gateway();
    const draftForm = await mountGroup();

    // Another operator made the plugin global; this draft still shows the group.
    state.plugin = { ...plugin, scope: "global" };
    state.fail.add("laterPage");
    updatePlan.mockRejectedValueOnce(stale(state.plugin));
    await submit();
    await settle();
    await act(async () => dialogButton("Keep my draft")!.click());
    await settle();

    expect(client.getQueryData(["pluginConfig", "default", "group-1"])).toEqual(state.plugin);
    expect(host.querySelector("form")).toBe(draftForm);
    // Still selected (its label now resolves from the picker's first page only).
    expect(selectedIds()).toEqual(["Remove /source", expect.stringContaining("destination")]);
    expect(host.querySelector("button[aria-label='Retry Proxy group membership']")).not.toBeNull();
    expect(document.body.textContent).not.toContain("API Error");
  });
});
