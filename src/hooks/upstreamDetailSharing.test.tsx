import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Upstream } from "@/api/types";
import { resourceFingerprint } from "@/lib/resourceBaseline";
import { toBaseline } from "@/api/upstreams";
import { useUpstream } from "./useUpstreams";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/upstreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/upstreams")>()),
  get,
}));
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "default", scope: { namespace: "default" } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A gateway read, parsed as ky parses it: `__proto__` is an own key. */
function read(label: string): Upstream {
  return JSON.parse(
    `{"id":"payments","algorithm":"round_robin","targets":[],` +
      `"subsets":[{"name":"blue","labels":{"release":"blue","__proto__":"${label}"}}]}`,
  ) as Upstream;
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function Probe() {
  useUpstream("payments");
  return null;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  root = createRoot(host);
  get.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});

describe("the upstream detail read (#725)", () => {
  it("keeps an own `__proto__` subset label through a refetch, so the baseline matches the gateway", async () => {
    get.mockResolvedValueOnce(read("v1")).mockResolvedValueOnce(read("v2"));
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["upstream", "default", "payments"] });
    });

    // What the editor seeds its form and baseline from.
    const cached = client.getQueryData<Upstream>(["upstream", "default", "payments"])!;
    expect(Object.hasOwn(cached.subsets![0].labels, "__proto__")).toBe(true);
    expect(cached.subsets![0].labels["__proto__"]).toBe("v2");
    expect(resourceFingerprint(toBaseline(cached))).toBe(resourceFingerprint(toBaseline(read("v2"))));
  });
});
