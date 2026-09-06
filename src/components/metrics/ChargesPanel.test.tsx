import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChargesPanel } from "./OpsPanels";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ scope: { namespace: "ferrum" } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let failure: number | "network" | "timeout" | null;
let consumers: Record<string, { total_calls: number; total_charges: number }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Request", BasedRequest);
  failure = null;
  consumers = {};
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/api/proxy/charges");
    expect(request.headers.get("X-Ferrum-Namespace")).toBe("ferrum");
    if (failure === "network") throw new TypeError("Failed to fetch");
    if (failure === "timeout") return new Promise<Response>(() => {});
    return Response.json(failure ? { error: "Unavailable" } : { consumers, currency: "USD" }, {
      status: typeof failure === "number" ? failure : 200,
    });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><ChargesPanel /></QueryClientProvider>));
}
async function advance(ms = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("chargeback observations", () => {
  it.each([500, 503, "network", "timeout"] as const)("reports %s as unavailable without inferring plugin configuration", async (reason) => {
    failure = reason;
    await mount();
    await advance(reason === "timeout" ? 11_000 : 2000);
    expect(host.textContent).toContain("Chargeback unavailable");
    expect(host.textContent).not.toContain("enable");
    expect(host.textContent).not.toContain("No metered usage");
  });

  it("keeps successful zero usage distinct from failure", async () => {
    await mount();
    await advance();
    expect(host.textContent).toContain("No metered usage recorded yet");
    expect(host.textContent).not.toContain("unavailable");
  });

  it("hides retained totals after a failed refresh and displays recovered totals", async () => {
    consumers = { sample: { total_calls: 2, total_charges: 1.25 } };
    await mount();
    await advance();
    expect(host.textContent).toContain("1.25");
    failure = 503;
    await act(async () => { void client.refetchQueries({ queryKey: ["charges"] }); });
    await advance();
    expect(host.textContent).toContain("Chargeback unavailable");
    expect(host.textContent).not.toContain("1.25");
    expect(client.getQueryData(["charges"])).toMatchObject({ consumers });
    failure = null;
    consumers = { sample: { total_calls: 3, total_charges: 2.50 } };
    await act(async () => { void client.refetchQueries({ queryKey: ["charges"] }); });
    await advance();
    expect(host.textContent).toContain("2.50");
    expect(host.textContent).not.toContain("unavailable");
  });
});
