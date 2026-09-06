import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ErrorPopupProvider, useErrorPopup } from "@/stores/error";
import { api, scoped, SILENT_ERRORS, setApiErrorHandler } from "@/api/client";
import { clearGatewayMetadata } from "@/api/gatewayMetadata";
import { useConsumer } from "./useConsumers";
import { useTlsInventory } from "./useTls";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
const notifications: string[] = [];
const counts = new Map<string, number>();
let respond: (request: Request, attempt: number) => Response | Promise<Response>;

function ConsumerProbe({ id }: { id: string }) {
  const query = useConsumer(id);
  return <p data-record={id}>{query.data?.username ?? (query.isError ? "failed" : "loading")}</p>;
}
function TlsProbe() {
  const query = useTlsInventory();
  return <p data-record="tls">{query.isError ? "failed" : query.data ? "loaded" : "loading"}</p>;
}
function NoticeProbe() {
  const { state } = useErrorPopup();
  useEffect(() => { if (state.open) notifications.push(state.body); }, [state]);
  return null;
}
function unavailable(body = "temporary") {
  return new Response(body, { status: 503, headers: { "retry-after": "0" } });
}
async function mount(ids = ["shared"], tls = false) {
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><NamespaceProvider><ErrorPopupProvider>
      <NoticeProbe />{ids.map((id, index) => <ConsumerProbe key={`${id}-${index}`} id={id} />)}
      {tls && <TlsProbe />}
    </ErrorPopupProvider></NamespaceProvider></QueryClientProvider>);
  });
}
async function settle(check: () => void) {
  await act(async () => { await vi.waitFor(check); });
}

beforeEach(() => {
  notifications.length = 0;
  counts.clear();
  clearGatewayMetadata();
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const attempt = (counts.get(path) ?? 0) + 1;
    counts.set(path, attempt);
    expect(request.headers.has("deferQueryErrors")).toBe(false);
    return respond(request, attempt);
  }));
  // Preserve the app's default retry count; only remove its delay for this fixture.
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: 300_000, retryDelay: 0 } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  setApiErrorHandler(undefined);
  clearGatewayMetadata();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("terminal query notifications", () => {
  it.each([1, 3])("recovers after %s failures across ky/Query without opening a dialog", async (failures) => {
    respond = (_request, attempt) => attempt <= failures ? unavailable() : Response.json({ id: "shared", username: "recovered-consumer" });
    await mount();
    await settle(() => expect(host.querySelector('[data-record="shared"]')?.textContent).toBe("recovered-consumer"));
    expect(counts.get("/api/proxy/consumers/shared")).toBe(failures + 1);
    expect(notifications).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("reports a permanent read once after all 12 attempts despite two observers", async () => {
    respond = () => {
      expect(notifications).toHaveLength(0);
      return unavailable("permanent consumer failure");
    };
    await mount(["shared", "shared"]);
    await settle(() => expect(notifications).toEqual(["permanent consumer failure"]));
    expect(counts.get("/api/proxy/consumers/shared")).toBe(12);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...host.querySelectorAll('[data-record="shared"]')].every((node) => node.textContent === "failed")).toBe(true);
  });

  it("does not dismiss another operation's failure after a later successful read", async () => {
    respond = (request, attempt) => request.url.endsWith("/bad")
      ? unavailable("unrelated permanent failure")
      : attempt === 1 ? unavailable() : Response.json({ id: "good", username: "recovered-good" });
    await mount(["bad"]);
    await settle(() => expect(notifications).toEqual(["unrelated permanent failure"]));
    await mount(["bad", "good"]);
    await settle(() => expect(host.querySelector('[data-record="good"]')?.textContent).toBe("recovered-good"));
    expect(notifications).toEqual(["unrelated permanent failure"]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("unrelated permanent failure");
  });

  it("uses the same terminal lifecycle for fleet-global TLS queries", async () => {
    respond = (request) => {
      expect(request.headers.has("X-Ferrum-Namespace")).toBe(false);
      expect(notifications).toHaveLength(0);
      return unavailable("TLS inventory unavailable");
    };
    await mount([], true);
    await settle(() => expect(notifications).toEqual(["TLS inventory unavailable"]));
    expect(counts.get("/api/proxy/admin/tls/inventory")).toBe(12);
  });
});

describe("direct configured client notifications", () => {
  it("reports no obsolete error after a successful safe retry", async () => {
    const report = vi.fn();
    setApiErrorHandler(report);
    respond = (_request, attempt) => attempt === 1 ? unavailable() : Response.json({ id: "shared" });
    await expect(api.get("api/proxy/consumers/shared", scoped({ namespace: "tenant-a" })).json()).resolves.toEqual({ id: "shared" });
    expect(counts.get("/api/proxy/consumers/shared")).toBe(2);
    expect(report).not.toHaveBeenCalled();
  });

  it.each(["plain failure", '{"error":"JSON failure","failures":["detail"]}', ""])("reports a terminal body once and preserves consumed error data: %j", async (body) => {
    const report = vi.fn();
    setApiErrorHandler(report);
    respond = () => new Response(body, { status: 503, headers: {
      "retry-after": "0", "content-type": body.startsWith("{") ? "application/json" : "text/plain",
    } });
    const error = await api.get("api/proxy/consumers/shared", scoped({ namespace: "tenant-a" })).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ response: { status: 503 } });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].body).toBe(body);
    expect(counts.get("/api/proxy/consumers/shared")).toBe(3);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("reports a failed %s after one attempt", async (method) => {
    const report = vi.fn();
    setApiErrorHandler(report);
    respond = () => unavailable("write failed");
    await expect(api("api/proxy/consumers/shared", scoped({ namespace: "tenant-a" }, { method }))).rejects.toThrow();
    expect(counts.get("/api/proxy/consumers/shared")).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each(["silent", "probe"])("keeps %s failures rejected without a global notification", async (mode) => {
    const report = vi.fn();
    setApiErrorHandler(report);
    respond = () => unavailable();
    const path = mode === "probe" ? "api/proxy/charges/usage" : "api/proxy/consumers/shared";
    await expect(api.get(path, scoped({ namespace: "tenant-a" }, {
      context: mode === "silent" ? { [SILENT_ERRORS]: true } : {},
    }))).rejects.toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  it("rejects and reports a timed-out write without replay", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    setApiErrorHandler(report);
    respond = (request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason));
    });
    const result = api.put("api/proxy/consumers/shared", scoped({ namespace: "tenant-a" }, { timeout: 100 })).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(counts.get("/api/proxy/consumers/shared")).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
