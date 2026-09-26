import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ToastProvider } from "@/components/ui/Toast";
import { setApiErrorHandler } from "@/api/client";
import { CredentialForm } from "@/components/forms/CredentialForm";
import { useEditorIdentity } from "@/hooks/useEditorIdentity";
import { useConsumer } from "@/hooks/useConsumers";
import type { BuiltInCredentialType, Consumer } from "@/api/types";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

let type: BuiltInCredentialType = "jwt";
function Page() {
  const session = useEditorIdentity("first");
  const query = useConsumer("first");
  return query.data ? <CredentialForm key={session.key} session={session}
    credentialType={type} existingCredentials={query.data.credentials[type]}
    revision={query.dataUpdatedAt} isRefreshing={query.isFetching} /> : null;
}

type WriteAnswer = "ok" | "committed" | "unobserved" | "rejected" | "echo";
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let answer: WriteAnswer;
let readStatus: number;
// Holds each write's answer until released, to land a read mid-write.
let gate: Promise<void> | null;
// Whether the first write's credential shows up in later reads.
let grown: boolean;
const writes: { method: string; path: string; body: unknown }[] = [];
const reads: string[] = [];
const settled: { status: string; data: unknown; error: unknown }[] = [];
const secret = "synthetic credential secret 0123456789abcdef";
const LABELS: Record<string, string> = {
  keyauth: "Key Authentication",
  jwt: "JWT",
  hmac_auth: "HMAC Authentication",
  basicauth: "Basic Authentication",
};

function record(namespace: string): Consumer {
  const added = grown && writes.length > 0 ? [{ secret: "[REDACTED]" }] : [];
  return { id: "first", namespace, username: "first", acl_groups: [], credentials: {
    keyauth: [{ key: "[REDACTED]" }, { key: "[REDACTED]" }],
    jwt: [{ secret: "[REDACTED]" }, ...added],
    hmac_auth: [{ secret: "[REDACTED]" }],
  }, created_at: "v1", updated_at: "v1" } as Consumer;
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
  await waitFor(() => expect(host.textContent).toContain(LABELS[type]));
}
function findButton(label: string, container: ParentNode = host) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}
async function click(label: string, container: ParentNode = host) {
  const button = findButton(label, container);
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => { button!.click(); });
}
async function enterSecret(value = secret) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.requestSubmit(); });
}
function dialog() { return document.querySelector('[role="dialog"]'); }
function notice() {
  return [...host.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "").join(" ");
}
/** No secret survives in the mutation's settled data or error, nor in any cache or storage. */
async function assertNoRetainedSecret() {
  await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
  expect(settled.length).toBeGreaterThan(0);
  for (const outcome of settled) {
    expect(JSON.stringify(outcome.data ?? null)).not.toContain(secret);
    if (outcome.error) {
      const error = outcome.error as Error & { cause?: unknown; options?: unknown; request?: unknown };
      expect(error.message).not.toContain(secret);
      expect(error.cause).toBeUndefined();
      expect(error.options).toBeUndefined();
      expect(error.request).toBeUndefined();
    }
  }
  expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state))).not.toContain(secret);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(secret);
}

beforeEach(() => {
  type = "jwt";
  answer = "ok";
  readStatus = 200;
  gate = null;
  grown = false;
  writes.length = 0;
  reads.length = 0;
  settled.length = 0;
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const tenant = request.headers.get("x-ferrum-namespace")!;
    if (request.method !== "GET") {
      writes.push({ method: request.method, path,
        body: request.method === "DELETE" ? undefined : await request.json() });
      if (gate) await gate;
      if (answer === "committed") {
        // Edge's committed-but-not-live family: the row is durable, the live
        // apply lagged. No cursor, so no apply-status poll joins the reads.
        return Response.json({ error: "committed, not yet live", applied: false,
          reason: "reload_timeout" }, { status: 503 });
      }
      if (answer === "unobserved") {
        return Response.json({ error: "upstream connection reset",
          code: "FERRUM_BFF_UPSTREAM_FAILURE" }, { status: 502 });
      }
      if (answer === "rejected") return Response.json({ error: "validation failed" }, { status: 400 });
      if (answer === "echo") {
        // A gateway that repeats the submitted value, raw and JSON-escaped.
        return Response.json({ error: `duplicate secret ${secret}`,
          details: JSON.stringify({ secret }) }, { status: 400 });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(record(tenant), { status: request.method === "POST" ? 201 : 200 });
    }
    reads.push(path);
    if (readStatus !== 200) return Response.json({ error: "read refused" }, { status: readStatus });
    return Response.json(record(tenant));
  }));
  qc = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: false },
  } });
  qc.getMutationCache().subscribe((event) => {
    const state = event.mutation?.state;
    if (event.type === "updated" && (state?.status === "success" || state?.status === "error")) {
      settled.push({ status: state.status, data: state.data, error: state.error });
    }
  });
  // Seeded in the past, so any re-read is a new revision even within one millisecond.
  qc.setQueryData(["consumer", "tenant-a", "first"], record("tenant-a"),
    { updatedAt: Date.now() - 60_000 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
});

describe("credential append outcomes (#451)", () => {
  it.each<BuiltInCredentialType>(["keyauth", "jwt", "hmac_auth"])(
    "disarms a committed-but-not-live %s append and shows the secret once",
    async (kind) => {
      type = kind;
      answer = "committed";
      await mount();
      await click("Add");
      await enterSecret();
      await submit();
      await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));

      // The same click cannot be repeated: the draft, the form and its submit
      // action are gone, and the committed-but-pending state stays visible.
      expect(host.querySelector("form")).toBeNull();
      expect(host.querySelector("input")).toBeNull();
      expect(findButton("Add Credential")).toBeUndefined();
      expect(notice()).toContain(`${LABELS[kind]} credential added: committed, not yet proven live`);
      expect(notice()).toContain("Reason: reload_timeout");
      expect(host.textContent).not.toContain("Failed to add credential");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual({ method: "POST",
        path: `/api/proxy/consumers/first/credentials/${kind}`, body: expect.any(Object) });
      // Reconciled against the committed state before the form closed.
      expect(reads).toEqual(["/api/proxy/consumers/first"]);
      await assertNoRetainedSecret();
      expect(settled.map((s) => s.status)).toEqual(["success"]);

      await click("I have saved these credentials");
      expect(host.querySelector("textarea")).toBeNull();
      await click("Add");
      expect(host.querySelector("input")?.value).toBe("");
      expect(notice()).not.toContain("committed, not yet proven live");
      expect(writes).toHaveLength(1);
    },
  );

  it("completes an ordinary append without a committed notice", async () => {
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("JWT credential added");
    expect(notice()).not.toContain("committed, not yet proven live");
    expect(writes).toHaveLength(1);
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
    await assertNoRetainedSecret();
  });

  it("keeps a genuinely rejected draft editable and armed", async () => {
    answer = "rejected";
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.textContent).toContain("validation failed"));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("input")?.value).toBe(secret);
    expect(findButton("Add Credential")?.disabled).toBe(false);
    expect(notice()).not.toContain("Outcome unknown");
    expect(writes).toHaveLength(1);
  });

  it("refuses to resubmit an unobserved append until the consumer has been re-read", async () => {
    answer = "unobserved";
    readStatus = 400;
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.textContent).toContain("Outcome unknown"));

    // The draft survives (it may be the only copy of a stored secret), but
    // the re-read failed, so nothing establishes whether it committed.
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("input")?.value).toBe(secret);
    expect(findButton("Add Credential")?.disabled).toBe(true);
    expect(notice()).toContain("disabled until the consumer has been re-read");
    await submit();
    expect(writes).toHaveLength(1);
    await assertNoRetainedSecret();
    expect(settled.map((s) => s.status)).toEqual(["error"]);

    // A successful re-read re-arms the form for an explicit, reconciled retry.
    readStatus = 200;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["consumer", "tenant-a", "first"], exact: true });
    });
    await waitFor(() => expect(findButton("Add Credential")?.disabled).toBe(false));
    expect(notice()).toContain("The consumer has been re-read");
    answer = "ok";
    await submit();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(writes).toHaveLength(2);
  });

  it("re-arms an unobserved append immediately when its re-read succeeds", async () => {
    answer = "unobserved";
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.textContent).toContain("Outcome unknown"));
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
    expect(host.querySelector("input")?.value).toBe(secret);
    expect(findButton("Add Credential")?.disabled).toBe(false);
    // The re-read lists no more JWT credentials than before the write.
    expect(notice()).toContain("lists no more jwt credentials than before this write");
    expect(notice()).toContain("likely not stored");
    await assertNoRetainedSecret();

    // The unknown outcome is not forgotten by Cancel or by reopening the form
    // (#466); only the next completed write clears it.
    await click("Cancel");
    expect(host.querySelector("form")).toBeNull();
    expect(notice()).toContain("Outcome unknown");
    await click("Add");
    expect(host.querySelector("input")?.value).toBe("");
    expect(notice()).toContain("Outcome unknown");
    answer = "ok";
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(notice()).not.toContain("Outcome unknown");
    expect(writes).toHaveLength(2);
  });

  it("says a lost append was likely stored when the re-read lists one more credential", async () => {
    answer = "unobserved";
    grown = true;
    await mount();
    expect(host.querySelectorAll('[aria-label^="Delete JWT credential"]')).toHaveLength(1);
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(notice()).toContain("Outcome unknown"));
    expect(host.querySelectorAll('[aria-label^="Delete JWT credential"]')).toHaveLength(2);
    expect(notice()).toContain("now lists more jwt credentials than before this write");
    expect(notice()).toContain("likely stored");
    expect(notice()).toContain("cannot be confirmed");
    expect(writes).toHaveLength(1);
  });

  it("keeps the lock when a refetch lands mid-write and the re-read after the error fails", async () => {
    answer = "unobserved";
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(writes).toHaveLength(1));

    // A focus refetch succeeds while the write is still in flight, advancing
    // the revision the submit handler rendered with.
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["consumer", "tenant-a", "first"], exact: true });
    });
    expect(reads).toEqual(["/api/proxy/consumers/first"]);

    // The answer is then lost, and the write's own re-read fails: nothing
    // read after the error establishes whether the credential committed.
    readStatus = 400;
    await act(async () => { release(); });
    await waitFor(() => expect(notice()).toContain("Outcome unknown"));
    expect(reads).toEqual(["/api/proxy/consumers/first", "/api/proxy/consumers/first"]);
    expect(findButton("Add Credential")?.disabled).toBe(true);
    expect(notice()).toContain("disabled until the consumer has been re-read");
    gate = null;
    await submit();
    expect(writes).toHaveLength(1);
  });

  it("writes once when the form is submitted twice before it re-renders", async () => {
    await mount();
    await click("Add");
    await enterSecret();
    await act(async () => {
      const form = host.querySelector("form")!;
      form.requestSubmit();
      form.requestSubmit();
    });
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(writes).toHaveLength(1);
  });

  it.each<BuiltInCredentialType>(["keyauth", "jwt", "hmac_auth"])(
    "reports a rejected %s append without the secret the gateway echoed",
    async (kind) => {
      type = kind;
      answer = "echo";
      const reported: unknown[] = [];
      setApiErrorHandler((error) => { reported.push(error); });
      await mount();
      await click("Add");
      await enterSecret();
      await submit();
      await waitFor(() => expect(host.textContent).toContain("duplicate secret [REDACTED]"));
      expect(host.textContent).not.toContain(secret);
      // The global popup would show the raw gateway body.
      expect(reported).toEqual([]);
      // The draft stays editable for a corrected retry.
      expect(host.querySelector("input")?.value).toBe(secret);
      expect(findButton("Add Credential")?.disabled).toBe(false);
      await assertNoRetainedSecret();
      expect(settled.map((s) => s.status)).toEqual(["error"]);
    },
  );
});

describe("basic credential and delete outcomes (#451)", () => {
  it("closes a committed-but-not-live basic replacement with its receipt", async () => {
    type = "basicauth";
    answer = "committed";
    await mount();
    await click("Replace basic credentials");
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(host.querySelector("form")).toBeNull();
    expect(findButton("Replace basic credentials")).toBeUndefined();
    expect(notice()).toContain("Basic credentials replaced: committed, not yet proven live");
    expect(host.textContent).not.toContain("Credential replacement failed");
    expect(writes).toEqual([{ method: "PUT", path: "/api/proxy/consumers/first/credentials/basicauth",
      body: { password: secret } }]);
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
    await assertNoRetainedSecret();
  });

  it("points a lost basic append at the replacement, which is safe to repeat", async () => {
    type = "basicauth";
    answer = "unobserved";
    await mount();
    await click("Add");
    await enterSecret();
    await submit();
    await waitFor(() => expect(notice()).toContain("Outcome unknown"));
    expect(notice()).toContain("does not list basic credentials");
    expect(notice()).toContain("cannot be observed");
    expect(notice()).toContain("use “Replace basic credentials” instead, which is safe to repeat");
    expect(writes).toEqual([{ method: "POST", path: "/api/proxy/consumers/first/credentials/basicauth",
      body: { password: secret } }]);

    // The outcome stays reported while the operator switches to the replacement.
    await click("Cancel");
    await click("Replace basic credentials");
    expect(notice()).toContain("Outcome unknown");
    answer = "ok";
    await enterSecret();
    await submit();
    await waitFor(() => expect(host.querySelector("textarea")?.value).toBe(secret));
    expect(notice()).not.toContain("Outcome unknown");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ method: "PUT" });
  });

  it("says a lost basic replacement is safe to repeat", async () => {
    type = "basicauth";
    answer = "unobserved";
    await mount();
    await click("Replace basic credentials");
    await enterSecret();
    await submit();
    await waitFor(() => expect(notice()).toContain("Outcome unknown"));
    expect(notice()).toContain("cannot be observed");
    expect(notice()).toContain("Replacing basic credentials again is safe to repeat");
  });

  it("closes the confirmation after a committed-but-not-live indexed delete", async () => {
    type = "keyauth";
    answer = "committed";
    await mount();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Delete Key Authentication credential 1"]')!.click();
    });
    await click("Delete Credential", dialog()!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(notice()).toContain("Key Authentication credential removed: committed, not yet proven live");
    expect(host.textContent).not.toContain("Failed to delete credential");
    expect(writes).toEqual([{ method: "DELETE",
      path: "/api/proxy/consumers/first/credentials/keyauth/0", body: undefined }]);
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
  });

  it("requires a fresh selection after an unobserved indexed delete", async () => {
    type = "keyauth";
    answer = "unobserved";
    await mount();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Delete Key Authentication credential 1"]')!.click();
    });
    await click("Delete Credential", dialog()!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(host.textContent).toContain("Outcome unknown");
    expect(writes).toHaveLength(1);
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
  });

  it("closes the confirmation after a committed-but-not-live delete of all basic credentials", async () => {
    type = "basicauth";
    answer = "committed";
    await mount();
    await click("Delete all basic credentials");
    await click("Delete all basic credentials", dialog()!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(notice()).toContain("All basic credentials deleted: committed, not yet proven live");
    expect(host.textContent).not.toContain("Failed to delete basic credentials");
    expect(writes).toHaveLength(1);
    expect(reads).toEqual(["/api/proxy/consumers/first"]);
  });
});
