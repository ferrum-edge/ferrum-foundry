import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Proxy } from "@/api/types";
import {
  NAMESPACE_STORAGE_KEY,
  NamespaceProvider,
  useNamespace,
} from "@/stores/namespace";
import { useCreateConsumer } from "./useConsumers";
import { useAllProxies } from "./useProxies";

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
  offset: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeProxy(id: string, namespace: string): Proxy {
  return {
    id,
    namespace,
    backend_host: `${id}.internal`,
    backend_port: 443,
    hosts: [],
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 1_000,
    backend_read_timeout_ms: 1_000,
    backend_write_timeout_ms: 1_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: false,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "v0",
    updated_at: "v0",
  };
}

/**
 * A gateway whose proxy listing has three tenant-a rows (served two per
 * page) and one tenant-b row. Every record names the namespace the request
 * asked for, so a listing that mixes namespaces is visible in its data.
 */
function proxiesPage(namespace: string, offset: number): Response {
  const rows =
    namespace === "tenant-a"
      ? [
          makeProxy("a-1", "tenant-a"),
          makeProxy("a-2", "tenant-a"),
          makeProxy("a-3", "tenant-a"),
        ]
      : [makeProxy(`${namespace}-1`, namespace)];
  const pageSize = 2;
  return json({
    data: rows.slice(offset, offset + pageSize),
    pagination: { offset, limit: 250, total: rows.length },
  });
}

type NamespaceHandle = ReturnType<typeof useNamespace>;

function ListingProbe({
  onValue,
}: {
  onValue: (value: NamespaceHandle) => void;
}) {
  const value = useNamespace();
  useAllProxies();
  useEffect(() => {
    onValue(value);
  });
  return <span data-testid="active">{value.selectedNamespace}</span>;
}

type CreateHandle = NamespaceHandle & {
  createConsumer: ReturnType<typeof useCreateConsumer>;
};

function CreateProbe({ onValue }: { onValue: (value: CreateHandle) => void }) {
  const value = useNamespace();
  const createConsumer = useCreateConsumer();
  useEffect(() => {
    onValue({ ...value, createConsumer });
  });
  return <span data-testid="active">{value.selectedNamespace}</span>;
}

describe("namespace binding through the query hooks", () => {
  const captured: CapturedRequest[] = [];
  let queryClient: QueryClient;
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  // Holds the first tenant-a page until the test releases it.
  let releaseFirstPage: () => void = () => {};
  let firstPageHeld: Promise<void>;

  async function mount(ui: ReactElement): Promise<void> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const created = createRoot(container);
    await act(async () => {
      created.render(
        <QueryClientProvider client={queryClient}>
          <NamespaceProvider>{ui}</NamespaceProvider>
        </QueryClientProvider>,
      );
    });
    host = container;
    root = created;
  }

  function displayed(): string {
    return host?.querySelector("[data-testid=active]")?.textContent ?? "";
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

  beforeEach(() => {
    captured.length = 0;
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    firstPageHeld = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        const namespace = request.headers.get("x-ferrum-namespace");
        const offset = url.searchParams.get("offset");
        captured.push({
          url: request.url,
          method: request.method,
          namespace,
          offset,
        });

        if (url.pathname === "/api/proxy/proxies" && request.method === "GET") {
          const at = Number(offset ?? "0");
          if (namespace === "tenant-a" && at === 0) await firstPageHeld;
          return proxiesPage(namespace ?? "unbound", at);
        }
        if (url.pathname === "/api/proxy/consumers" && request.method === "POST") {
          const body = (await request.clone().json()) as { username: string };
          return json({ id: body.username, username: body.username, namespace }, 201);
        }
        return json({ error: `unexpected ${request.method} ${url.pathname}` }, 500);
      }),
    );
  });

  afterEach(async () => {
    releaseFirstPage();
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

  it("fetches every page of a listing under the namespace it started in", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    let handle: NamespaceHandle | undefined;
    await mount(<ListingProbe onValue={(value) => { handle = value; }} />);

    // Page one of tenant-a is in flight and held.
    await waitFor(() => captured.some((r) => r.namespace === "tenant-a" && r.offset === "0"));

    // The user switches while the listing is still collecting pages.
    await act(async () => {
      handle!.setNamespace("tenant-b");
    });
    expect(displayed()).toBe("tenant-b");
    await waitFor(() => queryClient.getQueryData(["proxies", "tenant-b", "all"]) !== undefined);

    // Page two of the tenant-a listing goes out after the switch.
    releaseFirstPage();
    await waitFor(() => queryClient.getQueryData(["proxies", "tenant-a", "all"]) !== undefined);

    const pages = captured
      .filter((r) => r.url.includes("/api/proxy/proxies"))
      .map((r) => [r.offset, r.namespace]);
    expect(pages).toEqual([
      ["0", "tenant-a"],
      ["0", "tenant-b"],
      ["2", "tenant-a"],
    ]);

    // The collection cached under tenant-a holds tenant-a rows only, and the
    // one cached under tenant-b holds tenant-b rows only.
    const cachedA = queryClient.getQueryData<Proxy[]>(["proxies", "tenant-a", "all"]);
    expect(cachedA?.map((proxy) => [proxy.id, proxy.namespace])).toEqual([
      ["a-1", "tenant-a"],
      ["a-2", "tenant-a"],
      ["a-3", "tenant-a"],
    ]);
    const cachedB = queryClient.getQueryData<Proxy[]>(["proxies", "tenant-b", "all"]);
    expect(cachedB?.map((proxy) => proxy.namespace)).toEqual(["tenant-b"]);
  });

  it("sends a mutation to the displayed namespace after another tab switches", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    let handle: CreateHandle | undefined;
    await mount(<CreateProbe onValue={(value) => { handle = value; }} />);
    expect(displayed()).toBe("tenant-a");

    // Another tab switches to tenant-b and the browser tells this one.
    await act(async () => {
      localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-b");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: NAMESPACE_STORAGE_KEY,
          oldValue: "tenant-a",
          newValue: "tenant-b",
          storageArea: localStorage,
          url: "http://localhost/",
        }),
      );
    });
    expect(displayed()).toBe("tenant-a");

    await act(async () => {
      await handle!.createConsumer.mutateAsync({ username: "alice" });
    });

    const post = captured.find((r) => r.method === "POST");
    expect(post?.namespace).toBe("tenant-a");
    expect(post?.namespace).toBe(displayed());
  });

  it("binds a mutation to the namespace selected when it is triggered", async () => {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
    let handle: CreateHandle | undefined;
    await mount(<CreateProbe onValue={(value) => { handle = value; }} />);

    await act(async () => {
      handle!.setNamespace("tenant-b");
    });
    await act(async () => {
      await handle!.createConsumer.mutateAsync({ username: "bob" });
    });

    const post = captured.find((r) => r.method === "POST");
    expect(post?.namespace).toBe("tenant-b");
    expect(displayed()).toBe("tenant-b");
  });
});
