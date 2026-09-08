import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { AcmeOrder } from "@/api/tls";
import TlsPage from "./index";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

const key = ["tls", "acme", "orders", "all"];
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let status: AcmeOrder["status"];
let details: ((response: Response) => void)[];
let collections: ((response: Response) => void)[];
let holdCollections: boolean;
let posts: number;

function order(nextStatus = status): AcmeOrder {
  return {
    id: "fixture-order", domains: ["fixture.example.test"], status: nextStatus,
    directory_url: "https://ca.example.test/directory",
    created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  };
}

beforeEach(() => {
  status = "processing";
  details = [];
  collections = [];
  holdCollections = false;
  posts = 0;
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      posts += 1;
      return new Response("Unavailable", { status: 503 });
    }
    if (path.endsWith("/orders/fixture-order")) {
      return new Promise<Response>((resolve) => details.push(resolve));
    }
    const data = path.endsWith("/orders") ? [order()] : [];
    const response = Response.json({ data, pagination: { offset: 0, limit: 250, total: data.length } });
    if (path.endsWith("/orders") && holdCollections) {
      return new Promise<Response>((resolve) => collections.push(resolve));
    }
    return response;
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}

async function mount() {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/tls", component: TlsPage });
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/tls"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<QueryClientProvider client={client}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
  });
  await act(async () => {
    [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "ACME")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await settle(() => expect(panel().textContent).toContain("fixture-order"));
}

function panel() {
  return document.querySelector('[role="tabpanel"][data-state="active"]')!;
}

async function click(label: string) {
  const button = [...panel().querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.trim() === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

async function refresh(nextStatus: AcmeOrder["status"]) {
  status = nextStatus;
  await act(async () => { await client.refetchQueries({ queryKey: key }); });
  await settle(() => expect(client.getQueryData<AcmeOrder[]>(key)?.[0]?.status).toBe(nextStatus));
}

function expectTerminal(terminal: AcmeOrder["status"]) {
  expect(panel().textContent).toContain(terminal);
  expect(panel().textContent).not.toContain("Re-check status");
  expect(panel().textContent).not.toContain("Finalization in progress / unknown");
}

describe("ACME order observations", () => {
  it.each(["valid", "failed", "cancelled"] as const)("lets polling advance a manual result to %s", async (terminal) => {
    await mount();
    await click("Re-check status");
    await settle(() => expect(details).toHaveLength(1));
    await act(async () => details[0]!(Response.json(order("processing"))));
    await refresh(terminal);
    await settle(() => expectTerminal(terminal));
    expect(posts).toBe(0);
  });

  it.each(["valid", "failed", "cancelled"] as const)("ignores a delayed manual result after the collection reports %s", async (terminal) => {
    await mount();
    await click("Re-check status");
    await settle(() => expect(details).toHaveLength(1));
    await refresh(terminal);
    await act(async () => details[0]!(Response.json(order("processing"))));
    await settle(() => expectTerminal(terminal));
    expect(client.getQueryData<AcmeOrder[]>(key)?.[0]?.status).toBe(terminal);
    expect(posts).toBe(0);
  });

  it("resolves ambiguous finalization through GETs without another automatic POST", async () => {
    status = "ready";
    await mount();
    await click("Finalize");
    await settle(() => expect(panel().textContent).toContain("Finalization in progress / unknown"));
    expect(posts).toBe(1);
    await click("Re-check status");
    await settle(() => expect(details).toHaveLength(1));
    await act(async () => details[0]!(Response.json(order("processing"))));
    await refresh("valid");
    await settle(() => expectTerminal("valid"));
    expect(posts).toBe(1);
  });

  it("keeps a terminal detail result when an older collection request finishes later", async () => {
    status = "ready";
    await mount();
    await click("Finalize");
    await settle(() => expect(panel().textContent).toContain("Finalization in progress / unknown"));

    holdCollections = true;
    const staleCollection = client.refetchQueries({ queryKey: key });
    await settle(() => expect(collections).toHaveLength(1));
    await click("Re-check status");
    await settle(() => expect(details).toHaveLength(1));
    await act(async () => details[0]!(Response.json(order("valid"))));
    await settle(() => expectTerminal("valid"));

    await act(async () => collections[0]!(Response.json({
      data: [order("ready")],
      pagination: { offset: 0, limit: 250, total: 1 },
    })));
    await staleCollection;
    await settle(() => expectTerminal("valid"));
    expect(client.getQueryData<AcmeOrder[]>(key)?.[0]?.status).toBe("valid");
    expect(posts).toBe(1);
  });
});

it('keeps uncertain order creation disarmed after closing and reopening', async () => {
  await mount();
  await click('New ACME Order');
  const domains = document.querySelector<HTMLInputElement>('#domains')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      .call(domains, 'example.test');
    domains.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === 'Create Order')!;
  await act(async () => submit().click());
  await settle(() => {
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown');
    expect(submit().disabled).toBe(true);
  });
  await act(async () => submit().click());
  expect(posts).toBe(1);
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === 'Cancel')!;
  await act(async () => cancel.click());
  await click('New ACME Order');
  expect(submit().disabled).toBe(true);
});

it('blocks renewal after an uncertain response', async () => {
  await mount();
  await act(async () => {
    client.setQueryData(['tls', 'acme', 'certificates', 'all'], [{
      id: 'fixture-cert', domains: ['example.test'], status: 'issued',
      directory_url: 'https://ca.example.test/directory', source_uri: 'acme://fixture-cert',
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    }]);
  });
  const renew = () => [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Renew')!;
  // Query observers notify asynchronously after the certificate cache update.
  await settle(() => {
    expect(renew()).toBeTruthy();
    expect(renew().disabled).toBe(false);
  });
  await click('Renew');
  await settle(() => {
    expect(panel().textContent).toContain('Renewal outcome unknown');
    expect(renew().disabled).toBe(true);
  });
  await act(async () => renew().click());
  expect(posts).toBe(1);
});
