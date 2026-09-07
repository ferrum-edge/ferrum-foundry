import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NamespaceManagerCard } from "./NamespaceManagerCard";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY, useNamespace } from "@/stores/namespace";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: { role: "admin" } }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

function Selection() {
  const { selectedNamespace, setNamespace, scope } = useNamespace();
  return <>
    <select aria-label="Active namespace" value={selectedNamespace} onChange={(event) => setNamespace(event.target.value)}>
      {["ferrum", "tenant-a", "tenant-b", "tenant-c"].map((name) => <option key={name}>{name}</option>)}
    </select>
    <output data-testid="scope">{scope.namespace}</output>
  </>;
}

const record = (name: string, description = "") => ({
  name, description, created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
});
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let names: string[];
let writes: { url: URL; method: string; namespace: string | null; body: Record<string, unknown> }[];
let delayMutation: boolean;
let completeMutation: (() => void) | undefined;
let listReads: number;

beforeEach(() => {
  names = ["ferrum", "tenant-a", "tenant-c"];
  writes = [];
  delayMutation = false;
  completeMutation = undefined;
  listReads = 0;
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname.endsWith("/namespaces")) {
        listReads += 1;
        return Response.json({ data: names, pagination: { offset: 0, limit: 250, total: names.length } });
      }
      return Response.json(record(url.pathname.split("/").at(-1)!));
    }
    const body: Record<string, unknown> = request.method === "DELETE" ? {} : await request.json();
    writes.push({ url, method: request.method, namespace: request.headers.get("X-Ferrum-Namespace"), body });
    const finish = () => {
      if (request.method === "DELETE") {
        names = names.filter((name) => name !== "tenant-a");
        return new Response(null, { status: 204 });
      }
      const nextName = typeof body.name === "string" ? body.name : "tenant-a";
      if (request.method === "PUT") names = names.map((name) => name === "tenant-a" ? nextName : name);
      else names = [...names, nextName];
      return Response.json(record(nextName, typeof body.description === "string" ? body.description : ""));
    };
    if (delayMutation) return new Promise<Response>((resolve) => { completeMutation = () => resolve(finish()); });
    return finish();
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["namespaces"], names);
  for (const name of [...names, "tenant-b"]) client.setQueryData(["namespace", name], record(name));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  localStorage.removeItem(NAMESPACE_STORAGE_KEY);
});

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><NamespaceProvider><Selection /><NamespaceManagerCard /></NamespaceProvider></QueryClientProvider>,
  ));
}
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}
function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function click(text: string, within: ParentNode = document) {
  await act(async () => button(text, within).click());
}
function row() {
  return [...host.querySelectorAll("li")].find((entry) => entry.querySelector("span")?.textContent === "tenant-a")!;
}
async function input(index: number, value: string) {
  await act(async () => {
    const field = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')[index]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("pending namespace completion", () => {
  for (const operation of ["rename", "delete"] as const) {
    it.each([false, true])(`${operation} reconciles after dialog Close; later selection = %s`, async (switchSelection) => {
      delayMutation = true;
      await render();
      await click(operation === "rename" ? "Edit" : "Delete", row());
      if (operation === "rename") await input(0, "tenant-b");
      await click(operation === "rename" ? "Save" : "Delete Namespace");
      await settle(() => expect(completeMutation).toBeTypeOf("function"));
      expect(writes[0].namespace).toBe("tenant-a");
      expect(writes[0].url.pathname).toMatch(/\/namespaces\/tenant-a$/);
      expect(writes[0].url.search).toBe("");
      expect(writes[0].method).toBe(operation === "rename" ? "PUT" : "DELETE");
      expect(writes[0].body).toEqual(operation === "rename" ? { name: "tenant-b" } : {});
      await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      if (switchSelection) {
        await act(async () => {
          const select = host.querySelector("select")!;
          select.value = "tenant-c";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      await act(async () => completeMutation!());
      const expected = switchSelection ? "tenant-c" : operation === "rename" ? "tenant-b" : "ferrum";
      await settle(() => {
        expect(client.isMutating()).toBe(0);
        expect(host.querySelector("select")!.value).toBe(expected);
        expect(host.querySelector('[data-testid="scope"]')!.textContent).toBe(expected);
        expect(localStorage.getItem(NAMESPACE_STORAGE_KEY)).toBe(expected);
        expect(client.getQueryData(["namespace", "tenant-a"])).toBeUndefined();
        expect(listReads).toBeGreaterThan(0);
        expect(client.getQueryData(["namespaces"])).toEqual(names);
        expect(names).not.toContain("tenant-a");
      });
      expect(client.getQueryState(["namespace", "tenant-c"])?.isInvalidated).toBe(false);
      if (operation === "rename") {
        expect(names).toContain("tenant-b");
        expect(client.getQueryState(["namespace", "tenant-b"])?.isInvalidated).toBe(true);
      }
    });
  }
});

describe.each(["create", "edit"] as const)("%s description submission", (mode) => {
  async function open() {
    await render();
    await click(mode === "create" ? "New Namespace" : "Edit", mode === "create" ? host : row());
    if (mode === "create") await input(0, "tenant-b");
    expect(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')[1]!.hasAttribute("maxlength")).toBe(false);
  }
  const submit = () => click(mode === "create" ? "Create" : "Save");

  it("rejects 1025 emoji and submits 1024 after Unicode White_Space normalization", async () => {
    await open();
    await input(1, "😀".repeat(1025));
    await submit();
    expect(writes).toHaveLength(0);
    expect(document.body.textContent).toContain("Namespace description must be at most 1024 characters");
    const valid = "😀".repeat(1024);
    await input(1, `\u0085 ${valid}\u2003`);
    expect(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')[1]!.value).toBe(`\u0085 ${valid}\u2003`);
    await submit();
    await settle(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ ...(mode === "create" ? { name: "tenant-b" } : {}), description: valid });
  });

  it.each(["\ud800", "\udfff"])("rejects a lone surrogate %j without submitting", async (surrogate) => {
    await open();
    await input(1, `text${surrogate}`);
    await submit();
    expect(writes).toHaveLength(0);
    expect(document.body.textContent).toContain("Namespace description must contain valid Unicode characters");
  });

  it("counts BOM as a scalar instead of trimming it", async () => {
    await open();
    await input(1, `\ufeff${"😀".repeat(1024)}`);
    await submit();
    expect(writes).toHaveLength(0);
    expect(document.body.textContent).toContain("Namespace description must be at most 1024 characters");
    await input(1, "\ufeff");
    await submit();
    await settle(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.description).toBe("\ufeff");
  });

  it("preserves empty-description omission and edit no-op", async () => {
    await open();
    await input(1, "\u0085\u2003");
    await submit();
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    if (mode === "create") expect(writes[0].body).toEqual({ name: "tenant-b" });
    else expect(writes).toHaveLength(0);
  });
});

it("clears an existing description with null after Unicode whitespace normalization", async () => {
  client.setQueryData(["namespace", "tenant-a"], record("tenant-a", "old"));
  await render();
  await click("Edit", row());
  await input(1, "\u0085\u2003");
  await click("Save");
  await settle(() => expect(writes).toHaveLength(1));
  expect(writes[0].body).toEqual({ description: null });
});
