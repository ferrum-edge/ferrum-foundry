import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceProvider, useNamespace, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ToastProvider } from "@/components/ui/Toast";
import { CredentialForm } from "@/components/forms/CredentialForm";
import { useEditorIdentity } from "@/hooks/useEditorIdentity";
import { useConsumer } from "@/hooks/useConsumers";
import type { Consumer } from "@/api/types";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

let namespace: ReturnType<typeof useNamespace>;
let changeConsumer: (id: string) => void;
function Page() {
  const value = useNamespace();
  const [id, setId] = useState("first");
  const session = useEditorIdentity(id);
  const query = useConsumer(id);
  useEffect(() => { namespace = value; changeConsumer = setId; });
  return query.data ? <div data-revision={query.dataUpdatedAt}><CredentialForm key={session.key} session={session}
    credentialType="basicauth" existingCredentials={query.data.credentials.basicauth}
    revision={query.dataUpdatedAt} isRefreshing={query.isFetching} /></div> : null;
}

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let fail: boolean;
let hold: Promise<void> | undefined;
let release: (() => void) | undefined;
let holdRead: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
const writes: { method: string; path: string; namespace: string | null; body: unknown }[] = [];
const reads: string[] = [];
const secret = "synthetic replacement password 123456789";

function record(namespace: string, id: string): Consumer {
  return { id, namespace, username: `${namespace}-${id}`, acl_groups: [], credentials: {},
    created_at: "v1", updated_at: "v1" };
}
async function waitFor(check: () => void) {
  await act(async () => { await vi.waitFor(check); });
}
async function mount() {
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><ToastProvider><NamespaceProvider>
      <Page />
    </NamespaceProvider></ToastProvider></QueryClientProvider>);
  });
  await waitFor(() => expect(host.textContent).toContain("Basic Authentication"));
}
async function click(label: string, container: ParentNode = host) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => { button!.click(); });
}
async function enterPassword(value = secret) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function replace() {
  await click("Replace basic credentials");
  expect(host.querySelectorAll("input")).toHaveLength(1);
  expect(host.querySelector("input")?.type).toBe("password");
  expect(host.textContent).toContain("Existing passwords will stop working");
  await enterPassword();
  await act(async () => { host.querySelector("form")!.requestSubmit(); });
  await waitFor(() => expect(writes).toHaveLength(1));
}
function dialog() { return document.querySelector('[role="dialog"]'); }
async function assertClearedMutation() {
  await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
  expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state))).not.toContain(secret);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(secret);
}

beforeEach(() => {
  writes.length = 0;
  reads.length = 0;
  fail = false;
  hold = undefined;
  release = undefined;
  holdRead = undefined;
  releaseRead = undefined;
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const tenant = request.headers.get("x-ferrum-namespace");
    const id = path.split("/")[4]!;
    if (request.method !== "GET") {
      writes.push({ method: request.method, path, namespace: tenant,
        body: request.method === "DELETE" ? undefined : await request.json() });
      await hold;
      if (fail) return Response.json({ error: `rejected ${secret}` }, { status: 400 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
    } else {
      reads.push(`${tenant}/${id}`);
      await holdRead;
    }
    return Response.json(record(tenant!, id));
  }));
  qc = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } });
  for (const tenant of ["tenant-a", "tenant-b"]) {
    for (const id of ["first", "second"]) {
      qc.setQueryData(["consumer", tenant, id], record(tenant, id));
    }
    qc.setQueryData(["consumers", tenant, "all"], []);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  release?.();
  releaseRead?.();
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe("unobservable basic credential management", () => {
  it("never infers zero credentials and replaces through the real type endpoint with a copy-once receipt", async () => {
    await mount();
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).toContain("presence and count are unknown");
    expect(host.textContent).not.toContain("No basic");
    expect(host.querySelector('[aria-label^="Delete Basic Authentication credential"]')).toBeNull();
    await replace();
    expect(writes[0]).toEqual({ method: "PUT", path: "/api/proxy/consumers/first/credentials/basicauth",
      namespace: "tenant-a", body: { password: secret } });
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(host.querySelector("input")).toBeNull();
    expect(reads).toEqual(["tenant-a/first"]);
    expect(qc.getQueryState(["consumers", "tenant-a", "all"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["consumers", "tenant-b", "all"])?.isInvalidated).toBe(false);
    await assertClearedMutation();
    await click("I have saved these credentials");
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Unknown");
    await click("Replace basic credentials");
    expect(host.querySelector("input")?.value).toBe("");
  });

  it("clears failed replacement mutation variables and errors without retaining an echoed password", async () => {
    fail = true;
    await mount();
    await replace();
    await waitFor(() => expect(host.textContent).toContain("Credential replacement failed"));
    expect(host.textContent).not.toContain(secret);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("input")?.value).toBe(secret);
    await assertClearedMutation();
    await click("Cancel");
    await click("Replace basic credentials");
    expect(host.querySelector("input")?.value).toBe("");
    expect(writes).toHaveLength(1);
  });

  it("confirms destructive deletion and uses DELETE by type even when ordinary credentials are empty", async () => {
    await mount();
    await click("Delete all basic credentials");
    expect(dialog()?.textContent).toContain("consumer first in namespace tenant-a");
    expect(dialog()?.textContent).toContain("All existing basic passwords will stop working");
    expect(writes).toHaveLength(0);
    await click("Delete all basic credentials", dialog()!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(writes).toEqual([{ method: "DELETE", path: "/api/proxy/consumers/first/credentials/basicauth",
      namespace: "tenant-a", body: undefined }]);
    expect(reads).toEqual(["tenant-a/first"]);
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).not.toContain("No basic");
    await assertClearedMutation();
  });

  it("requires a fresh confirmation after a consumer refresh", async () => {
    await mount();
    await click("Delete all basic credentials");
    const updatedAt = Date.now() + 10;
    await act(async () => {
      qc.setQueryData(["consumer", "tenant-a", "first"], record("tenant-a", "first"), { updatedAt });
    });
    await waitFor(() => expect(host.querySelector("[data-revision]")?.getAttribute("data-revision")).toBe(String(updatedAt)));
    await click("Delete all basic credentials", dialog()!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(writes).toHaveLength(0);
    expect(host.textContent).toContain("Confirm deletion of all basic credentials again");
  });

  it("keeps replacement pending until the originating consumer refresh settles", async () => {
    holdRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    await mount();
    await replace();
    await waitFor(() => expect(reads).toEqual(["tenant-a/first"]));
    expect(host.querySelector("input")?.disabled).toBe(true);
    expect(host.querySelector("textarea")).toBeNull();
    await act(async () => { releaseRead!(); await holdRead; });
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    await assertClearedMutation();
  });

  it.each(["namespace", "consumer"])("clears drafts, receipts and confirmations on a %s switch", async (kind) => {
    const switchEditor = async (back = false) => {
      await act(async () => {
        if (kind === "namespace") namespace.setNamespace(back ? "tenant-a" : "tenant-b");
        else changeConsumer(back ? "first" : "second");
      });
    };
    await mount();
    await click("Replace basic credentials");
    await enterPassword();
    await switchEditor();
    expect(host.querySelector("input")).toBeNull();
    await click("Delete all basic credentials");
    await switchEditor(true);
    expect(dialog()).toBeNull();
    expect(writes).toHaveLength(0);
    await replace();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    await switchEditor();
    expect(host.querySelector("textarea")).toBeNull();
  });

  it.each(["namespace", "consumer"])("keeps late replacement completion bound to the original %s and does not reveal its receipt", async (kind) => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    await mount();
    await replace();
    await act(async () => {
      if (kind === "namespace") namespace.setNamespace("tenant-b");
      else changeConsumer("second");
    });
    await click("Replace basic credentials");
    await enterPassword("new editor draft");
    await act(async () => { release!(); await hold; });
    await assertClearedMutation();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("input")?.value).toBe("new editor draft");
    expect(host.textContent).not.toContain("Basic credentials replaced");
    expect(writes[0]?.namespace).toBe("tenant-a");
    expect(reads).toEqual([]);
    expect(qc.getQueryState(["consumer", "tenant-a", "first"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["consumer", "tenant-b", "first"])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(["consumer", "tenant-a", "second"])?.isInvalidated).toBe(false);
  });

  it("does not close a new editor's confirmation or toast after a late type deletion", async () => {
    hold = new Promise<void>((resolve) => { release = resolve; });
    await mount();
    await click("Delete all basic credentials");
    await click("Delete all basic credentials", dialog()!);
    await waitFor(() => expect(writes).toHaveLength(1));
    await act(async () => { namespace.setNamespace("tenant-b"); });
    await click("Delete all basic credentials");
    await act(async () => { release!(); await hold; });
    await assertClearedMutation();
    expect(dialog()?.textContent).toContain("namespace tenant-b");
    expect(host.textContent).not.toContain("All basic credentials deleted");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.namespace).toBe("tenant-a");
    expect(reads).toEqual([]);
  });

  it("discards a late replacement failure after the editor changes", async () => {
    fail = true;
    hold = new Promise<void>((resolve) => { release = resolve; });
    await mount();
    await replace();
    await act(async () => { namespace.setNamespace("tenant-b"); });
    await act(async () => { release!(); await hold; });
    await assertClearedMutation();
    expect(host.textContent).not.toContain("Credential replacement failed");
    expect(host.textContent).not.toContain(secret);
    expect(host.querySelector("textarea")).toBeNull();
  });
});
