import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { NamespaceProvider, useNamespace, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ToastProvider } from "@/components/ui/Toast";
import { CredentialForm } from "@/components/forms/CredentialForm";
import { useEditorIdentity } from "@/hooks/useEditorIdentity";
import { get as getConsumer } from "@/api/consumers";
import type { BuiltInCredentialType } from "@/api/types";
import ConsumerNewPage from "./new";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let namespace: ReturnType<typeof useNamespace>;
let type: BuiltInCredentialType = "keyauth";
function Probe() {
  const value = useNamespace();
  useEffect(() => { namespace = value; });
  return null;
}
function AppendPage() {
  const session = useEditorIdentity("new-user");
  return <CredentialForm key={session.key} session={session} credentialType={type}
    existingCredentials={[]} revision={1} isRefreshing={false} />;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const createRoutePage = createRoute({ getParentRoute: () => rootRoute, path: "/consumers/new", component: ConsumerNewPage });
const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/consumers/$consumerId", component: () => <p>Consumer detail destination</p> });
const appendRoute = createRoute({ getParentRoute: () => rootRoute, path: "/append", component: AppendPage });
const tree = rootRoute.addChildren([createRoutePage, detailRoute, appendRoute]);

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let fail = false;
let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
const writes: unknown[] = [];
const copy = vi.fn();
const redacted = { id: "new-user", username: "new-user", acl_groups: [], credentials: {
  keyauth: [{ key: "[REDACTED]" }], jwt: [{ secret: "[REDACTED]" }], hmac_auth: [{ secret: "[REDACTED]" }],
} };

async function mount(path: string) {
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><ToastProvider><NamespaceProvider>
      <Probe /><RouterProvider router={router} />
    </NamespaceProvider></ToastProvider></QueryClientProvider>);
  });
  await act(async () => { await vi.waitFor(() => expect(host.textContent).not.toBe("")); });
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(found, label).toBeTruthy();
  return found!;
}
async function click(label: string) {
  await act(async () => { button(label).click(); });
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.requestSubmit(); });
}
function assertNoPersistence(secret: string) {
  expect(JSON.stringify(qc.getQueryCache().getAll().map((query) => query.state))).not.toContain(secret);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(secret);
}

beforeEach(() => {
  writes.length = 0;
  fail = false;
  hold = undefined;
  release = undefined;
  copy.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (request.method === "POST") {
      writes.push(await request.json());
      await hold;
      return fail ? Response.json({ error: "validation failed" }, { status: 400 }) : Response.json(redacted, { status: 201 });
    }
    return Response.json(redacted);
  }));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  release?.();
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

describe("submitted credential recovery", () => {
  it.each(["key-auth", "jwt", "hmac-auth", "basic-auth"])("retains generated %s after create until explicitly acknowledged", async (id) => {
    await mount("/consumers/new");
    await typeInto(host.querySelector<HTMLInputElement>("#username")!, "new-user");
    await click("Credentials");
    const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
    await act(async () => { field.closest(".items-end")!.querySelector<HTMLButtonElement>("button")!.click(); });
    const secret = field.value;
    expect(secret).toHaveLength(32);
    await submit();
    await act(async () => { await vi.waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret)); });
    expect(host.textContent).not.toContain("Consumer detail destination");
    expect(host.querySelector("form")).toBeNull();
    expect(writes).toHaveLength(1);
    const copyButton = [...host.querySelectorAll("button")].find((item) => item.textContent?.startsWith("Copy "))!;
    await act(async () => { copyButton.click(); });
    expect(copy).toHaveBeenCalledWith(secret);
    assertNoPersistence(secret);
    await act(async () => { await vi.waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0)); });
    await click("I have saved these credentials");
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain("Consumer detail destination")); });
    expect(host.querySelector("textarea")).toBeNull();
    expect(JSON.stringify(await getConsumer({ namespace: "tenant-a" }, "new-user"))).not.toContain(secret);
    expect(writes).toHaveLength(1);
  });

  it.each<BuiltInCredentialType>(["keyauth", "jwt", "hmac_auth", "basicauth"])("shows appended %s once and handles unavailable clipboard", async (kind) => {
    type = kind;
    await mount("/append");
    await click("Add");
    const secret = " exact submitted secret with spaces 123456789 ";
    await typeInto(host.querySelector("input")!, secret);
    await submit();
    await act(async () => { await vi.waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret)); });
    expect(host.querySelector("form")).toBeNull();
    copy.mockRejectedValueOnce(new Error("clipboard denied"));
    const copyButton = [...host.querySelectorAll("button")].find((item) => item.textContent?.startsWith("Copy "))!;
    await act(async () => { copyButton.click(); });
    expect(host.textContent).toContain("copy it manually");
    expect(host.querySelector("textarea")?.value).toBe(secret);
    assertNoPersistence(secret);
    await act(async () => { await vi.waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0)); });
    await click("I have saved these credentials");
    expect(host.querySelector("textarea")).toBeNull();
    await click("Add");
    expect(host.querySelector("input")?.value).toBe("");
    expect(writes).toHaveLength(1);
  });

  it("keeps failed input editable without showing a successful receipt or replaying", async () => {
    type = "keyauth";
    fail = true;
    await mount("/append");
    await click("Add");
    await typeInto(host.querySelector("input")!, "synthetic-key");
    await submit();
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain("validation failed")); });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("input")?.value).toBe("synthetic-key");
    expect(writes).toHaveLength(1);
  });

  it("clears the originating namespace receipt on namespace change", async () => {
    type = "keyauth";
    await mount("/append");
    await click("Add");
    await typeInto(host.querySelector("input")!, "tenant-a-secret");
    await submit();
    await act(async () => { await vi.waitFor(() => expect(host.querySelector("textarea")).not.toBeNull()); });
    await act(async () => { namespace.setNamespace("tenant-b"); });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).not.toContain("tenant-a-secret");
  });

  it("does not reveal a late successful append in a different namespace", async () => {
    type = "keyauth";
    hold = new Promise<void>((resolve) => { release = resolve; });
    await mount("/append");
    await click("Add");
    await typeInto(host.querySelector("input")!, "tenant-a-late-secret");
    await submit();
    await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); });
    await act(async () => { namespace.setNamespace("tenant-b"); });
    await act(async () => { release!(); await hold; });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).not.toContain("tenant-a-late-secret");
  });
});
