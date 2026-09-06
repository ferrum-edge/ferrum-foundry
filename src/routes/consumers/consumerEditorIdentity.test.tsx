import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { Consumer } from "@/api/types";
import { ToastProvider } from "@/components/ui/Toast";
import {
  NAMESPACE_STORAGE_KEY,
  NamespaceProvider,
  useNamespace,
} from "@/stores/namespace";
import ConsumerDetailPage from "./$consumerId";

vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ principal: null }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = new URL(input, "http://localhost").toString();
    }
    super(input, init);
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  namespace: string | null;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyPage(): Response {
  return json({ data: [], pagination: { offset: 0, limit: 250, total: 0 } });
}

/** Tenants A and B both hold a consumer with the same id and distinct fields. */
function consumerFixture(namespace: string): Consumer {
  return {
    id: "shared",
    namespace,
    username: `${namespace}-user`,
    custom_id: `${namespace}-custom`,
    acl_groups: [`${namespace}-group`],
    credentials: {},
    created_at: "v0",
    updated_at: "v0",
  };
}

type NamespaceHandle = ReturnType<typeof useNamespace>;

function NamespaceProbe({ onValue }: { onValue: (value: NamespaceHandle) => void }) {
  const value = useNamespace();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const consumersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consumers",
  component: () => <p data-testid="consumers-list">Consumers</p>,
});
const consumerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consumers/$consumerId",
  component: ConsumerDetailPage,
});
const routeTree = rootRoute.addChildren([consumersRoute, consumerDetailRoute]);

const DETAIL_PATH = "/api/proxy/consumers/shared";

describe("consumer editor identity across a namespace switch", () => {
  const captured: CapturedRequest[] = [];
  const records = new Map<string, Consumer>();
  const holds = new Map<string, Promise<void>>();
  let queryClient: QueryClient;
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  let handle: NamespaceHandle | undefined;

  /** Hold every `<METHOD> <namespace>` detail request until released. */
  function hold(key: string): () => void {
    let release: () => void = () => {};
    holds.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  async function mount(): Promise<void> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/consumers/shared"] }),
    });
    const created = createRoot(container);
    await act(async () => {
      created.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <NamespaceProvider>
              <NamespaceProbe
                onValue={(value) => {
                  handle = value;
                }}
              />
              <RouterProvider router={router} />
            </NamespaceProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    host = container;
    root = created;
  }

  function heading(): string {
    return host?.querySelector("h1")?.textContent ?? "";
  }

  /** `Input` derives the element id from its label: "Custom ID" → `custom-id`. */
  function field(id: string): HTMLInputElement | null {
    return host?.querySelector<HTMLInputElement>(`#${id}`) ?? null;
  }

  function pageText(): string {
    return host?.textContent ?? "";
  }

  function dialog(): Element | null {
    return document.querySelector('[role="dialog"]');
  }

  function detailGets(namespace: string): CapturedRequest[] {
    return captured.filter(
      (r) => r.method === "GET" && r.namespace === namespace && r.url.endsWith(DETAIL_PATH),
    );
  }

  function puts(): CapturedRequest[] {
    return captured.filter((r) => r.method === "PUT");
  }

  async function switchTo(namespace: string): Promise<void> {
    await act(async () => {
      handle!.setNamespace(namespace);
    });
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    // Go through the prototype setter so React's value tracker sees the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function submitForm(): Promise<void> {
    await act(async () => {
      host!.querySelector("form")!.requestSubmit();
    });
  }

  /** Poll `check` while flushing React and TanStack Query work between polls. */
  async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  /** Open under tenant-a with tenant-b visited too, so both detail queries are cached. */
  async function mountWithBothTenantsCached(): Promise<void> {
    await mount();
    await waitFor(() => heading() === "tenant-a-user");
    await switchTo("tenant-b");
    await waitFor(() => heading() === "tenant-b-user");
    await switchTo("tenant-a");
    await waitFor(() => heading() === "tenant-a-user");
    expect(queryClient.getQueryData(["consumer", "tenant-b", "shared"])).toBeDefined();
  }

  beforeEach(() => {
    captured.length = 0;
    holds.clear();
    handle = undefined;
    records.clear();
    records.set("tenant-a", consumerFixture("tenant-a"));
    records.set("tenant-b", consumerFixture("tenant-b"));
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    queryClient = new QueryClient({
      defaultOptions: {
        // Both tenants stay fresh once visited: the switch under test is a
        // pure cache hit, exactly the case the issue reproduces.
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        const method = request.method;
        const namespace = request.headers.get("x-ferrum-namespace");
        const body =
          method === "PUT" || method === "POST"
            ? ((await request.clone().json()) as unknown)
            : undefined;
        captured.push({ url: request.url, method, namespace, body });
        await holds.get(`${method} ${namespace}`);

        const tenant = namespace ?? "unbound";
        if (url.pathname === DETAIL_PATH) {
          const record = records.get(tenant);
          if (method === "GET") {
            return record ? json(record) : json({ error: "not found" }, 404);
          }
          if (method === "PUT" && record) {
            const next = { ...record, ...(body as Partial<Consumer>), updated_at: "v1" };
            records.set(tenant, next);
            return json(next);
          }
          if (method === "DELETE") {
            records.delete(tenant);
            return new Response(null, { status: 204 });
          }
        }
        if (
          method === "GET" &&
          ["/api/proxy/consumers", "/api/proxy/proxies", "/api/proxy/plugins/config"].includes(
            url.pathname,
          )
        ) {
          return emptyPage();
        }
        return json({ error: `unexpected ${method} ${url.pathname}` }, 500);
      }),
    );
  });

  afterEach(async () => {
    const activeRoot = root;
    const activeHost = host;
    root = null;
    host = null;
    if (activeRoot) {
      await act(async () => {
        activeRoot.unmount();
      });
    }
    activeHost?.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  });

  it("re-seeds the editor from the newly selected tenant on a cached switch and submits only that tenant's fields", async () => {
    await mountWithBothTenantsCached();
    expect(field("username")?.value).toBe("tenant-a-user");
    const detailGetsBefore = captured.filter((r) => r.url.endsWith(DETAIL_PATH)).length;

    await switchTo("tenant-b");

    // A cache hit: no request and no loading branch, yet nothing of tenant-a
    // survives in the editor.
    expect(captured.filter((r) => r.url.endsWith(DETAIL_PATH))).toHaveLength(detailGetsBefore);
    expect(heading()).toBe("tenant-b-user");
    expect(field("username")?.value).toBe("tenant-b-user");
    expect(field("custom-id")?.value).toBe("tenant-b-custom");
    expect(pageText()).toContain("tenant-b-group");
    expect(pageText()).not.toContain("tenant-a");

    await submitForm();
    await waitFor(() => puts().length === 1);

    const [put] = puts();
    expect(put.namespace).toBe("tenant-b");
    expect(put.body).toMatchObject({
      id: "shared",
      username: "tenant-b-user",
      custom_id: "tenant-b-custom",
      acl_groups: ["tenant-b-group"],
    });
    expect(JSON.stringify(put.body)).not.toContain("tenant-a");
    expect(records.get("tenant-a")).toEqual(consumerFixture("tenant-a"));
  });

  it("shows the loading branch, never tenant-a's fields, on an uncached switch", async () => {
    await mount();
    await waitFor(() => heading() === "tenant-a-user");
    const release = hold("GET tenant-b");

    await switchTo("tenant-b");
    await waitFor(() => detailGets("tenant-b").length === 1);

    expect(heading()).toBe("");
    expect(host?.querySelector("form")).toBeNull();
    expect(pageText()).not.toContain("tenant-a");

    release();
    await waitFor(() => heading() === "tenant-b-user");
    expect(field("username")?.value).toBe("tenant-b-user");
    expect(field("custom-id")?.value).toBe("tenant-b-custom");
    expect(pageText()).toContain("tenant-b-group");
    expect(pageText()).not.toContain("tenant-a");
  });

  it("keeps an in-progress edit when the same identity is refetched in the background", async () => {
    await mount();
    await waitFor(() => heading() === "tenant-a-user");

    await act(async () => {
      typeInto(field("username")!, "edited-locally");
    });
    expect(field("username")?.value).toBe("edited-locally");

    // The gateway now reports a change made elsewhere to the same consumer.
    records.set("tenant-a", {
      ...consumerFixture("tenant-a"),
      username: "tenant-a-user-renamed",
      custom_id: "tenant-a-custom-v2",
      updated_at: "v1",
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["consumer", "tenant-a", "shared"] });
    });
    await waitFor(() => heading() === "tenant-a-user-renamed");

    // Live data drives the heading; the editor keeps its seed and the edit.
    expect(field("username")?.value).toBe("edited-locally");
    expect(field("custom-id")?.value).toBe("tenant-a-custom");

    await submitForm();
    await waitFor(() => puts().length === 1);
    expect(puts()[0].namespace).toBe("tenant-a");
    expect(puts()[0].body).toMatchObject({
      username: "edited-locally",
      custom_id: "tenant-a-custom",
    });
  });

  it("discards a pending delete confirmation when the tenant changes", async () => {
    await mountWithBothTenantsCached();
    const deleteButton = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Delete",
    );
    expect(deleteButton).toBeDefined();

    await act(async () => {
      deleteButton!.click();
    });
    await waitFor(() => dialog() !== null);
    expect(dialog()?.textContent).toContain('"tenant-a-user"');

    await switchTo("tenant-b");
    await waitFor(() => dialog() === null);

    expect(heading()).toBe("tenant-b-user");
    expect(captured.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("lets a submission that started under tenant-a finish there without touching tenant-b's editor", async () => {
    await mountWithBothTenantsCached();
    const release = hold("PUT tenant-a");

    await act(async () => {
      typeInto(field("username")!, "tenant-a-edit");
    });
    await submitForm();
    await waitFor(() => puts().length === 1);
    expect(puts()[0].namespace).toBe("tenant-a");

    // The operator switches while that write is still in flight.
    await switchTo("tenant-b");
    expect(heading()).toBe("tenant-b-user");
    expect(field("username")?.value).toBe("tenant-b-user");

    release();
    // The write reconciles its captured tenant, without invalidating tenant-b.
    await waitFor(() => queryClient.getQueryData<Consumer>(["consumer", "tenant-a", "shared"])?.username === "tenant-a-edit");
    expect(detailGets("tenant-b")).toHaveLength(1);

    expect(puts()).toHaveLength(1);
    expect(records.get("tenant-a")?.username).toBe("tenant-a-edit");
    expect(records.get("tenant-b")?.username).toBe("tenant-b-user");
    expect(heading()).toBe("tenant-b-user");
    expect(field("username")?.value).toBe("tenant-b-user");
  });

  it("invalidates an indexed delete confirmation after the credential list refreshes", async () => {
    records.set("tenant-a", {
      ...consumerFixture("tenant-a"),
      credentials: { keyauth: [{ key: "redacted" }, { key: "redacted" }] },
    });
    await mount();
    await waitFor(() => heading() === "tenant-a-user");
    await act(async () => {
      [...host!.querySelectorAll("button")].find((button) => button.textContent === "Credentials")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[aria-label="Delete Key Authentication credential 1"]')!.click();
    });
    await waitFor(() => dialog() !== null);
    records.set("tenant-a", {
      ...consumerFixture("tenant-a"),
      credentials: { keyauth: [{ key: "redacted" }] },
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["consumer", "tenant-a", "shared"] });
    });
    // An enabled button alone may still belong to the pre-refresh render.
    // Observe the new list AND settled button before dispatching confirmation.
    await waitFor(() =>
      host!.querySelector('[aria-label="Delete Key Authentication credential 2"]') === null &&
      [...dialog()!.querySelectorAll("button")].some(
        (button) => button.textContent === "Delete Credential" && !button.disabled,
      ),
    );
    await act(async () => {
      [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Delete Credential")!.click();
    });
    await waitFor(() => dialog() === null);
    expect(captured.filter((request) => request.method === "DELETE")).toHaveLength(0);
    expect(document.body.textContent).toContain("Select the credential again");
  });

  it("keeps ACL edits pending through reconciliation and retains the first accepted group", async () => {
    await mount();
    await waitFor(() => heading() === "tenant-a-user");
    await act(async () => {
      [...host!.querySelectorAll("button")].find((button) => button.textContent === "ACL Groups")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const input = host!.querySelector<HTMLInputElement>('[placeholder="Enter group name"]')!;
    const releasePut = hold("PUT tenant-a");
    await act(async () => { typeInto(input, "first-group"); });
    await submitForm();
    await waitFor(() => puts().length === 1);
    const releaseRead = hold("GET tenant-a");
    releasePut();
    await waitFor(() => queryClient.getQueryData<Consumer>(["consumer", "tenant-a", "shared"])?.acl_groups?.includes("first-group") === true);
    const addButton = [...host!.querySelectorAll("button")].find((button) => button.textContent === "Add")!;
    expect(addButton.disabled).toBe(true);
    await act(async () => {
      typeInto(input, "second-group");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(puts()).toHaveLength(1);
    releaseRead();
    await waitFor(() => !addButton.disabled || input.value === "");
    await act(async () => { typeInto(input, "second-group"); });
    await waitFor(() => !addButton.disabled);
    await submitForm();
    await waitFor(() => puts().length === 2);
    expect(puts()[1].body).toMatchObject({
      acl_groups: ["tenant-a-group", "first-group", "second-group"],
    });
  });

});
