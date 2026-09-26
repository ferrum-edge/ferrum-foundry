import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ToastProvider } from "@/components/ui/Toast";
import { setApiErrorHandler } from "@/api/client";
import type { ApiError } from "@/api/types";
import { inputByLabel } from "@/test/fields";
import ConsumerNewPage from "./new";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Creating a consumer sends the keys and secrets typed into the form. A
// gateway refusal that repeats one must not reach the toast, the global error
// popup, or the rejected mutation's error (#478).

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const createRoutePage = createRoute({ getParentRoute: () => rootRoute, path: "/consumers/new", component: ConsumerNewPage });
const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/consumers/$consumerId", component: () => <p>Consumer detail destination</p> });
const tree = rootRoute.addChildren([createRoutePage, detailRoute]);

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
const writes: unknown[] = [];
const reported: ApiError[] = [];
const errors: unknown[] = [];

async function mount() {
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/consumers/new"] }) });
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><ToastProvider><NamespaceProvider>
      <RouterProvider router={router} />
    </NamespaceProvider></ToastProvider></QueryClientProvider>);
  });
  await act(async () => { await vi.waitFor(() => expect(host.textContent).not.toBe("")); });
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(found, label).toBeTruthy();
  await act(async () => { found!.click(); });
}

beforeEach(() => {
  writes.length = 0;
  reported.length = 0;
  errors.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  setApiErrorHandler((error) => reported.push(error));
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (request.method === "POST") {
      const body = await request.json() as { credentials: { keyauth: { key: string }[] } };
      writes.push(body);
      const key = body.credentials.keyauth[0].key;
      // A gateway that repeats the submitted key raw, JSON-escaped, and whole.
      return Response.json({ error: `duplicate key ${key}`, code: key,
        details: JSON.stringify({ key }) }, { status: 409 });
    }
    return Response.json({});
  }));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") errors.push(event.action.error);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
});

describe("a refused consumer create that echoes a submitted secret (#478)", () => {
  // Deterministic but non-repeating, so any fragment of it is distinctive.
  const long = Array.from({ length: 1000 }, (_, i) => ((i * 2654435761) % 36).toString(36))
    .join("");
  const quoted = 'synthetic "quoted" \\ backslash secret 0123456789';
  const padded = "   synthetic padded secret 0123456789abcdef   ";

  it.each([
    ["a 1000-character key", long],
    ["a key that needs JSON escapes", quoted],
    ["a whitespace-padded key", padded],
  ])("keeps no fragment of %s in the toast, the popup, or the error", async (_, secret) => {
    await mount();
    await typeInto(inputByLabel(host, "Username"), "new-user");
    await click("Credentials");
    await typeInto(inputByLabel(host, "Key Auth"), secret);
    await act(async () => { host.querySelector("form")!.requestSubmit(); });
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("duplicate key [REDACTED]"));
    });

    const exposed = [secret.trim(), JSON.stringify(secret.trim()).slice(1, -1)];
    for (let start = 0; start + 32 <= secret.length; start += 16) {
      exposed.push(secret.slice(start, start + 32));
    }
    for (const fragment of exposed) expect(document.body.textContent).not.toContain(fragment);

    // The global popup would show the raw gateway body.
    expect(reported).toEqual([]);
    // The rejected mutation's error keeps neither the echo nor the request.
    expect(errors).toHaveLength(1);
    const error = errors[0] as Error & Record<string, unknown>;
    expect(error).not.toHaveProperty("request");
    expect(error).not.toHaveProperty("options");
    expect(error.cause).toBeUndefined();
    const retained = `${error.message}\n${JSON.stringify(error.data ?? null)}`;
    expect(retained).toContain("[REDACTED]");
    for (const fragment of exposed) expect(retained).not.toContain(fragment);

    // Nothing was created: the form stays for a corrected retry, unreplayed.
    expect(host.textContent).not.toContain("Consumer detail destination");
    expect(host.querySelector("form")).not.toBeNull();
    expect(writes).toHaveLength(1);
    await act(async () => { await vi.waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0)); });
  });
});
