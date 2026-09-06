import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { ApiSpecSummary } from "@/api/apiSpecs";
import ApiSpecsPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "tenant-a" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

function summary(id: string): ApiSpecSummary {
  return {
    id, proxy_id: `proxy-${id}`, namespace: "tenant-a", title: `API ${id}`,
    spec_version: "3.1.0", spec_format: "yaml", info_version: "1", description: null,
    contact_name: null, contact_email: null, license_name: null, license_identifier: null,
    tags: [], server_urls: [], operation_count: 1, uncompressed_size: 100,
    content_hash: id, content_encoding: "gzip",
    created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let reads: { id: string; resolve: (response: Response) => void }[];
let writes: { id: string; document: string; resolve: (response: Response) => void }[];

beforeEach(() => {
  reads = [];
  writes = [];
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const id = path.split("/").at(-1)!;
    if (request.method === "PUT") {
      const document = await request.text();
      return new Promise<Response>((resolve) => writes.push({ id, document, resolve }));
    }
    if (id === "api-specs") {
      return Response.json({ items: [summary("A"), summary("B")], total: 2, limit: 20, offset: 0, next_offset: null });
    }
    return new Promise<Response>((resolve) => reads.push({ id, resolve }));
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
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <ToastProvider><ApiSpecsPage /></ToastProvider>
    </QueryClientProvider>,
  ));
  await settle(() => expect(host.textContent).toContain("API A"));
}

async function click(label: string, index = 0) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label)[index]!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

function editor() {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="OpenAPI document"]')!;
}

async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openReplace(index: number, count: number) {
  await click("Replace", index);
  await settle(() => expect(reads).toHaveLength(count));
}

async function resolveRead(index: number, text: string, status = 200) {
  await act(async () => reads[index]!.resolve(new Response(text, { status })));
  await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
}

describe("API spec dialog generations", () => {
  it.each([200, 400])("ignores a cancelled A response (%s) after B is edited and submits only B", async (status) => {
    await mount();
    await openReplace(0, 1);
    expect(editor().disabled).toBe(true);
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Replace Spec")!;
    expect(submit.disabled).toBe(true);
    await click("Cancel");
    await openReplace(1, 2);
    await resolveRead(1, "document B");
    await settle(() => expect(editor().disabled).toBe(false));
    await edit("edited document B");
    await resolveRead(0, "stale document A", status);
    expect(editor().value).toBe("edited document B");
    expect(document.body.textContent).not.toContain("stale document A");
    await click("Replace Spec");
    await settle(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ id: "B", document: "edited document B" });
    await act(async () => writes[0]!.resolve(Response.json({ id: "B", proxy_id: "proxy-B" })));
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });

  it("retires the first read when the same spec is reopened", async () => {
    await mount();
    await openReplace(0, 1);
    await click("Close");
    await openReplace(0, 2);
    await resolveRead(1, "current A");
    await settle(() => expect(editor().disabled).toBe(false));
    await edit("edited A");
    await resolveRead(0, "old A");
    expect(editor().value).toBe("edited A");
  });

  it("does not overwrite a new import with a cancelled replacement read", async () => {
    await mount();
    await openReplace(0, 1);
    await click("Cancel");
    await click("Import Spec");
    expect(editor().value).toContain("openapi: 3.1.0");
    await edit("new import draft");
    await resolveRead(0, "old A");
    expect(editor().value).toBe("new import draft");
  });

  it("does not close a newer editor when a previous replacement finishes", async () => {
    await mount();
    await openReplace(0, 1);
    await resolveRead(0, "current A");
    await settle(() => expect(editor().disabled).toBe(false));
    await click("Replace Spec");
    await settle(() => expect(writes).toHaveLength(1));
    await click("Cancel");
    await openReplace(1, 2);
    await resolveRead(1, "current B");
    await act(async () => writes[0]!.resolve(Response.json({ id: "A", proxy_id: "proxy-A" })));
    await settle(() => expect(editor().value).toBe("current B"));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Replace API B");
  });

  it("keeps a newer view paired with its own document", async () => {
    await mount();
    await click("View", 0);
    await settle(() => expect(reads).toHaveLength(1));
    await click("Close");
    await click("View", 1);
    await settle(() => expect(reads).toHaveLength(2));
    await resolveRead(1, "view B");
    await resolveRead(0, "view A");
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("view B");
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("view A");
  });
});
