import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { AcmeOrder } from "@/api/tls";
import type { PaginatedResponse } from "@/api/types";
import TlsPage from "./index";
import { inputByLabel } from "@/test/fields";
import { clearOutcomeLatches } from "@/stores/outcomeLatches";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

// The tab reads one server page; refetches address every cached order page.
const key = ["tls", "acme", "orders"];
const firstPage = [...key, { offset: 0, limit: 20 }];

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let status: AcmeOrder["status"];
let details: ((response: Response) => void)[];
let collections: ((response: Response) => void)[];
let holdCollections: boolean;
let posts: number;
let extraOrders: AcmeOrder[];
let certificates: unknown[];

function cachedOrders() {
  return client.getQueryData<PaginatedResponse<AcmeOrder>>(firstPage)?.data;
}

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
  extraOrders = [];
  certificates = [];
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
    const data = path.endsWith("/orders")
      ? [order(), ...extraOrders]
      : path.endsWith("/certificates") ? certificates : [];
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
  clearOutcomeLatches();
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
  await selectTab("ACME");
  await settle(() => expect(panel().textContent).toContain("fixture-order"));
}

async function selectTab(label: string) {
  await act(async () => {
    [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === label)!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

/** Leave the ACME tab (Radix unmounts its panel) and come back. */
async function revisitAcmeTab() {
  await selectTab("Validate");
  await settle(() => expect(panel().textContent).not.toContain("fixture-order"));
  await selectTab("ACME");
  await settle(() => expect(panel().textContent).toContain("fixture-order"));
}

async function refetchOrders() {
  await act(async () => { await client.refetchQueries({ queryKey: key }); });
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
  await settle(() => expect(cachedOrders()?.[0]?.status).toBe(nextStatus));
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
    expect(cachedOrders()?.[0]?.status).toBe(terminal);
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
    expect(cachedOrders()?.[0]?.status).toBe("valid");
    expect(posts).toBe(1);
  });
});

it('keeps uncertain order creation disarmed after closing and reopening', async () => {
  await mount();
  await click('New ACME Order');
  const domains = inputByLabel(document.querySelector('[role="dialog"]')!, 'Domains');
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
    client.setQueryData(['tls', 'acme', 'certificates', { offset: 0, limit: 20 }], {
      data: [{
        id: 'fixture-cert', domains: ['example.test'], status: 'issued',
        directory_url: 'https://ca.example.test/directory', source_uri: 'acme://fixture-cert',
        created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
      }],
      pagination: { offset: 0, limit: 20, total: 1 },
    });
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

const fixtureCertificate = {
  id: 'fixture-cert', domains: ['example.test'], status: 'issued',
  directory_url: 'https://ca.example.test/directory', source_uri: 'acme://fixture-cert',
  created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
};

describe('outcome-unknown latches outlive the ACME tab', () => {
  const renew = () => [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Renew')!;
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === 'Create Order')!;

  it('keeps an uncertain renewal disarmed across a tab switch until an order shows it', async () => {
    certificates = [fixtureCertificate];
    await mount();
    await settle(() => expect(renew()?.disabled).toBe(false));
    await click('Renew');
    await settle(() => expect(panel().textContent).toContain('Renewal outcome unknown'));

    await revisitAcmeTab();
    await settle(() => expect(renew()).toBeTruthy());
    expect(panel().textContent).toContain('Renewal outcome unknown');
    expect(renew().disabled).toBe(true);
    await act(async () => renew().click());
    expect(posts).toBe(1);

    // An older order for the certificate proves nothing about this request.
    extraOrders = [{
      ...order('valid'), id: 'old-renewal', certificate_id: 'fixture-cert',
      created_at: '2026-09-05T00:00:00Z',
    }];
    await refetchOrders();
    await settle(() => expect(panel().textContent).toContain('old-renewal'));
    expect(renew().disabled).toBe(true);

    // The renewal order it created ends the latch.
    extraOrders = [{
      ...order('pending_challenges'), id: 'new-renewal', certificate_id: 'fixture-cert',
      created_at: '2026-09-07T00:00:00Z',
    }];
    await refetchOrders();
    await settle(() => {
      expect(panel().textContent).not.toContain('Renewal outcome unknown');
      expect(renew().disabled).toBe(false);
    });
    expect(posts).toBe(1);
  });

  it('keeps uncertain order creation disarmed across a tab switch until the order appears', async () => {
    await mount();
    await click('New ACME Order');
    const domains = inputByLabel(document.querySelector('[role="dialog"]')!, 'Domains');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        .call(domains, 'example.test');
      domains.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => submit().click());
    await settle(() => expect(submit().disabled).toBe(true));
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.trim() === 'Cancel')!;
    await act(async () => cancel.click());

    await revisitAcmeTab();
    await click('New ACME Order');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown');
    expect(submit().disabled).toBe(true);
    await act(async () => submit().click());
    expect(posts).toBe(1);

    extraOrders = [{ ...order('pending_challenges'), id: 'created-order', domains: ['example.test'], created_at: '2026-09-07T00:00:00Z' }];
    await refetchOrders();
    await settle(() => {
      expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('outcome unknown');
      expect(submit().disabled).toBe(false);
    });
  });

  it('keeps an uncertain finalization on Re-check across a tab switch', async () => {
    status = 'ready';
    await mount();
    await click('Finalize');
    await settle(() => expect(panel().textContent).toContain('Finalization in progress / unknown'));

    await revisitAcmeTab();
    expect(panel().textContent).toContain('Finalization in progress / unknown');
    const labels = [...panel().querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toContain('Re-check status');
    expect(labels).not.toContain('Finalize');
    expect(posts).toBe(1);
  });
});
