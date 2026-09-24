import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcmeOrder, AcmeOrderStatus } from "@/api/tls";
import { stubFetch, page } from "@/test/__tests__/harness";
import { useAcmeOrders } from "./useTls";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let statuses: AcmeOrderStatus[];
let reads: number;
let requested: URL[];

function order(id: string, status: AcmeOrderStatus): AcmeOrder {
  return {
    id, status, domains: [`${id}.example.test`], directory_url: "https://ca.example.test/directory",
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  } as AcmeOrder;
}

function Probe() {
  useAcmeOrders({ offset: 0, limit: 20 });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  reads = 0;
  requested = [];
  stubFetch((request) => {
    reads += 1;
    requested.push(new URL(request.url));
    return Response.json(page(statuses.map((status, index) => order(`o${index}`, status))));
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function observeFor(ms: number) {
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const initial = reads;
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  return reads - initial;
}

describe("ACME order polling", () => {
  it("stops re-reading every order once all of them have settled", async () => {
    statuses = ["valid", "failed", "cancelled"];
    expect(await observeFor(60_000)).toBe(0);
    expect(requested).toHaveLength(1);
    expect(requested[0].searchParams.get("offset")).toBe("0");
    expect(requested[0].searchParams.get("limit")).toBe("20");
  });

  it("keeps polling while an order can still change", async () => {
    statuses = ["valid", "processing"];
    expect(await observeFor(60_000)).toBeGreaterThanOrEqual(3);
  });
});
