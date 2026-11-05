import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";
import type { ApiSpecSummary } from "@/api/apiSpecs";
import ApiSpecsPage from "./index";
import { clearOutcomeLatches, latchOutcome } from "@/stores/outcomeLatches";

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
    id, proxy_id: `proxy-${id}`, title: `API ${id}`,
    spec_version: "3.1.0", spec_format: "yaml", info_version: "1", description: null,
    contact_name: null, contact_email: null, license_name: null, license_identifier: null,
    tags: [], server_urls: [], operation_count: 1, uncompressed_size: 100,
    content_hash: id,
    created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  };
}

// Edge's `content_hash` (the SHA-256 of the stored bytes) for a spec holding
// 'document A' and 'document A edited': reads that match what was sent.
const DOCUMENT_A_SHA256 = '09fb3f175100d052d86fa9ae67e5dedf94d2c239d1bfec4da5f3e217585652b4';
const EDITED_SHA256 = '70dd68d6fa151c951b1bb09761d71ffcc0aef18fd44f7c623804eec3c352f1ad';

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let reads: { id: string; resolve: (response: Response) => void }[];
let writes: { id: string; document: string; resolve: (response: Response) => void }[];
let specList: ApiSpecSummary[];

beforeEach(() => {
  reads = [];
  writes = [];
  specList = [summary("A"), summary("B")];
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const id = path.split("/").at(-1)!;
    if (request.method === "PUT" || request.method === "POST") {
      const document = await request.text();
      return new Promise<Response>((resolve) => writes.push({ id, document, resolve }));
    }
    if (id === "api-specs") {
      return Response.json({ items: specList, total: specList.length, limit: 20, offset: 0, next_offset: null });
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

  it("shows the parse code and details when the gateway rejects a replacement", async () => {
    await mount();
    await openReplace(0, 1);
    await resolveRead(0, "current A");
    await settle(() => expect(editor().disabled).toBe(false));
    await click("Replace Spec");
    await settle(() => expect(writes).toHaveLength(1));

    const details =
      "x-ferrum-proxy: unknown field `backend_protocol` at line 6 column 3";
    await act(async () =>
      writes[0]!.resolve(
        Response.json(
          { error: "Spec parse failed", code: "MalformedExtension", details },
          { status: 400 },
        ),
      ),
    );

    await settle(() => expect(document.body.textContent).toContain("MalformedExtension"));
    expect(document.body.textContent).toContain(details);
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

it.each(['import', 'replace'])('blocks repeating an uncertain spec %s across dialog reopen', async (mode) => {
  await mount();
  if (mode === 'replace') {
    await openReplace(0, 1);
    await resolveRead(0, 'document A');
    await settle(() => expect(editor().disabled).toBe(false));
  } else {
    await click('Import Spec');
    await edit('document A');
  }
  const label = mode === 'replace' ? 'Replace Spec' : 'Import Spec';
  // The page and dialog can both have an Import Spec button.
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === label)!;
  await act(async () => submit().click());
  await settle(() => expect(writes).toHaveLength(1));
  await act(async () => writes[0]!.resolve(Response.json({
    code: 'FERRUM_BFF_TIMEOUT', phase: 'response',
  }, { status: 504 })));
  await settle(() => {
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown');
    expect(submit().disabled).toBe(true);
  });
  await act(async () => submit().click());
  expect(writes).toHaveLength(1);
  await click('Cancel');
  await click('Import Spec');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown');
  expect(editor().disabled).toBe(true);
});

it.each(['import', 'replace'])('reports a committed-but-not-live spec %s as saved, not locked', async (mode) => {
  await mount();
  if (mode === 'replace') {
    await openReplace(0, 1);
    await resolveRead(0, 'document A');
    await settle(() => expect(editor().disabled).toBe(false));
  } else {
    await click('Import Spec');
    await edit('document A');
  }
  const label = mode === 'replace' ? 'Replace Spec' : 'Import Spec';
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === label)!;
  await act(async () => submit().click());
  await settle(() => expect(writes).toHaveLength(1));
  await act(async () => writes[0]!.resolve(Response.json(
    { error: 'reload timed out', applied: false, reason: 'reload_timeout' },
    { status: 503, headers: { 'x-ferrum-config-cursor': '1:2' } },
  )));
  // The write is durable: the dialog closes so it is not submitted twice, and
  // the workspace is not locked as if the outcome were unknown.
  await settle(() => {
    expect(document.querySelector('textarea[aria-label="OpenAPI document"]')).toBeNull();
    expect(document.body.textContent).toContain('committed, not yet proven live');
    expect(document.body.textContent).not.toContain('outcome unknown');
  });
  await click('Import Spec');
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('outcome unknown');
  expect(editor().disabled).toBe(false);
});

const REARM = 'Allow another import or replacement';
const CONFIRM_REARM = "I've checked — allow writes";

it.each(['import', 'replace'])('keeps an uncertain spec %s disarmed through matching reads and remounts until the operator re-arms it', async (mode) => {
  await mount();
  if (mode === 'replace') {
    await openReplace(0, 1);
    await resolveRead(0, 'document A');
    await settle(() => expect(editor().disabled).toBe(false));
    await edit('document A edited');
  } else {
    await click('Import Spec');
    await edit('document A');
  }
  const label = mode === 'replace' ? 'Replace Spec' : 'Import Spec';
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === label)!;
  await act(async () => submit().click());
  await settle(() => expect(writes).toHaveLength(1));
  await act(async () => writes[0]!.resolve(Response.json({
    code: 'FERRUM_BFF_TIMEOUT', phase: 'response',
  }, { status: 504 })));
  await settle(() => expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown'));
  await click('Cancel');
  expect(host.textContent).toContain('Spec write outcome unknown');

  // A read holding exactly the document sent proves nothing about this
  // request: the spec may have held it already.
  specList = mode === 'replace'
    ? [{ ...summary('A'), content_hash: EDITED_SHA256, updated_at: '2026-09-07T00:00:00Z' }, summary('B')]
    : [summary('A'), summary('B'), { ...summary('C'), content_hash: DOCUMENT_A_SHA256, created_at: '2026-09-07T00:00:00Z' }];
  await act(async () => { await client.refetchQueries({ queryKey: ['apiSpecs'] }); });
  await settle(() => expect(host.textContent).toContain(mode === 'replace' ? 'API A' : 'API C'));
  expect(host.textContent).toContain('Spec write outcome unknown');

  // Leaving the route unmounts the workspace; coming back must not re-arm it.
  await act(async () => root.render(
    <QueryClientProvider client={client}><ToastProvider><div /></ToastProvider></QueryClientProvider>,
  ));
  await mount();
  expect(host.textContent).toContain('Spec write outcome unknown');
  await click('Import Spec');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('outcome unknown');
  expect(editor().disabled).toBe(true);
  await click('Cancel');

  // Re-arming asks first; declining keeps the block.
  await click(REARM);
  await settle(() => expect(document.querySelector('[role="dialog"]')?.textContent)
    .toContain('Allow another spec import or replacement?'));
  await click('Cancel');
  await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(host.textContent).toContain('Spec write outcome unknown');

  await click(REARM);
  await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click(CONFIRM_REARM);
  await settle(() => expect(host.textContent).not.toContain('Spec write outcome unknown'));
  await click('Import Spec');
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('outcome unknown');
  expect(editor().disabled).toBe(false);
  expect(writes).toHaveLength(1);
});

it('keeps submit and re-arm disabled across remounts while any spec write for the namespace runs', async () => {
  const remount = async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}><ToastProvider><div /></ToastProvider></QueryClientProvider>,
    ));
    await mount();
  };
  const dialogSubmit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === 'Import Spec')!;
  const rearm = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === REARM);

  // Write A starts, then the workspace is left while it runs.
  await mount();
  await click('Import Spec');
  await edit('document A');
  await act(async () => dialogSubmit().click());
  await settle(() => expect(writes).toHaveLength(1));
  await click('Cancel');
  await remount();

  // The new mount's own mutation observers are idle, but A is not.
  await click('Import Spec');
  await edit('document B');
  expect(dialogSubmit().disabled).toBe(true);
  await act(async () => dialogSubmit().click());
  expect(writes).toHaveLength(1);
  await click('Cancel');

  // An earlier unanswered write is latched meanwhile; re-arming it now would
  // let another write start while A may still land.
  await act(async () => latchOutcome({
    kind: 'api_spec_write', namespace: 'tenant-a', message: 'Spec import outcome unknown.',
  }));
  await remount();
  await settle(() => expect(rearm()).toBeTruthy());
  expect(rearm()!.disabled).toBe(true);
  await act(async () => rearm()!.click());
  expect(document.body.textContent).not.toContain('Allow another spec import or replacement?');

  // A's lost answer, arriving after two remounts, still latches the namespace.
  await act(async () => writes[0]!.resolve(Response.json({
    code: 'FERRUM_BFF_TIMEOUT', phase: 'response',
  }, { status: 504 })));
  await settle(() => expect(rearm()!.disabled).toBe(false));
  expect(host.textContent).toContain('Spec write outcome unknown');

  // Only now, with nothing in flight, can the operator re-arm and write again.
  await act(async () => rearm()!.click());
  await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click(CONFIRM_REARM);
  await settle(() => expect(host.textContent).not.toContain('Spec write outcome unknown'));
  await click('Import Spec');
  await edit('document B');
  expect(dialogSubmit().disabled).toBe(false);
  await act(async () => dialogSubmit().click());
  await settle(() => expect(writes).toHaveLength(2));
});

it('re-arms only the unknown write the operator reviewed', async () => {
  await mount();
  await act(async () => latchOutcome({
    kind: 'api_spec_write', namespace: 'tenant-a', message: 'Spec import outcome unknown.',
  }));
  await click(REARM);
  await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

  // Another unanswered write replaces it while the confirmation is open.
  await act(async () => latchOutcome({
    kind: 'api_spec_write', namespace: 'tenant-a', message: 'Spec replacement outcome unknown.',
  }));
  await click(CONFIRM_REARM);
  await settle(() => expect(document.body.textContent).toContain('review it before allowing writes again'));
  expect(host.textContent).toContain('Spec replacement outcome unknown.');
  expect(host.textContent).toContain('Spec write outcome unknown');
});

it('reports an import that succeeds after its dialog was closed', async () => {
  await mount();
  await click('Import Spec');
  await edit('document C');
  const submit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === 'Import Spec')!;
  await act(async () => submit.click());
  await settle(() => expect(writes).toHaveLength(1));
  await click('Cancel');
  await act(async () => writes[0]!.resolve(Response.json({
    id: 'C', proxy_id: 'proxy-C', spec_version: '3.1.0', content_hash: 'C',
  }, { status: 201 })));
  await settle(() => expect(document.body.textContent).toContain('Spec imported — proxy proxy-C created'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
