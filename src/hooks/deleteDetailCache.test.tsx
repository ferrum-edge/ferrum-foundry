import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeletePluginWithMembership } from "./usePlugins";
import { useDeleteConsumer } from "./useConsumers";
import { useDeleteProxy, useProxy } from "./useProxies";
import { useDeleteUpstream } from "./useUpstreams";
import type { PluginConfig } from "@/api/types";
import PluginDetailPage from "@/routes/plugins/$pluginId";

let namespace: string;
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: namespace, scope: { namespace } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ pluginId: "same-id" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
const hooks = {
  membership: useDeletePluginWithMembership,
  consumer: useDeleteConsumer,
  proxy: useDeleteProxy,
  upstream: useDeleteUpstream,
};
const cases = [
  ["membership", "pluginConfig"],
  ["consumer", "consumer"], ["proxy", "proxy"], ["upstream", "upstream"],
] as const;
let remove: (id: string) => Promise<unknown>;
function Probe({ kind }: { kind: keyof typeof hooks }) {
  const useDelete = hooks[kind];
  const mutation = useDelete();
  useEffect(() => { remove = (id) => mutation.mutateAsync({ id, guard: null }); });
  return null;
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let deletion: { namespace: string | null; resolve: (response: Response) => void }[];
let serverPlugin: PluginConfig;
let updates: unknown[];

beforeEach(() => {
  namespace = "tenant-a";
  deletion = [];
  updates = [];
  serverPlugin = {
    id: "same-id", plugin_name: "response_mock", scope: "global", enabled: true,
    config: { ordinary: "retired" },
    created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z",
  };
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "DELETE") {
      return new Promise<Response>((resolve) => deletion.push({ namespace: request.headers.get("X-Ferrum-Namespace"), resolve }));
    }
    if (request.method === "PUT") {
      const data = await request.json();
      updates.push(data);
      serverPlugin = { ...serverPlugin, ...data };
      return Response.json(serverPlugin);
    }
    if (path.endsWith("/plugins/config/same-id")) return Response.json(serverPlugin);
    if (path.endsWith("/plugins")) return Response.json(["response_mock"]);
    return Response.json({ data: [], pagination: { offset: 0, limit: 250, total: 0 } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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

async function render(ui: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}

for (const [kind, detail] of cases) {
  describe(`${kind} detail retirement`, () => {
    it("removes only the confirmed deleted identity despite a namespace switch", async () => {
      for (const [scope, id] of [["tenant-a", "same-id"], ["tenant-b", "same-id"], ["tenant-a", "other-id"]]) {
        client.setQueryData([detail, scope, id], { preserved: `${scope}:${id}` });
      }
      await render(<Probe kind={kind} />);
      const pending = remove("same-id");
      await settle(() => expect(deletion).toHaveLength(1));
      namespace = "tenant-b";
      await render(<Probe kind={kind} />);
      await act(async () => {
        deletion[0]!.resolve(new Response(null, { status: 204 }));
        await pending;
      });
      expect(deletion[0]!.namespace).toBe("tenant-a");
      expect(client.getQueryData([detail, "tenant-a", "same-id"])).toBeUndefined();
      expect(client.getQueryData([detail, "tenant-b", "same-id"])).toBeDefined();
      expect(client.getQueryData([detail, "tenant-a", "other-id"])).toBeDefined();
    });

    it("retains the detail when deletion fails", async () => {
      client.setQueryData([detail, namespace, "same-id"], { preserved: true });
      await render(<Probe kind={kind} />);
      const pending = remove("same-id").catch((error: unknown) => error);
      await settle(() => expect(deletion).toHaveLength(1));
      await act(async () => {
        deletion[0]!.resolve(new Response("Refused", { status: 400 }));
        await pending;
      });
      expect(client.getQueryData([detail, namespace, "same-id"])).toEqual({ preserved: true });
    });
  });
}

const committedCases = [
  ["consumer", "consumer", "consumers"],
  ["proxy", "proxy", "proxies"],
  ["upstream", "upstream", "upstreams"],
] as const;

for (const [kind, detail, list] of committedCases) {
  it(`${kind}: a committed-but-not-live delete retires the seeded detail and lists (#430)`, async () => {
    client.setQueryData([detail, namespace, "same-id"], { preserved: true });
    client.setQueryData([list, namespace, "all"], [{ id: "same-id" }]);
    await render(<Probe kind={kind} />);
    const pending = remove("same-id");
    await settle(() => expect(deletion).toHaveLength(1));
    let outcome: unknown;
    await act(async () => {
      deletion[0]!.resolve(Response.json(
        { error: "reload timed out", applied: false, reason: "reload_timeout" },
        { status: 503, headers: { "x-ferrum-config-cursor": "1:2" } },
      ));
      outcome = await pending;
    });
    // The delete is durable, so it completes as a delete and says why it is
    // not yet live, rather than rejecting as a failure.
    expect(outcome).toEqual({
      namespace: "tenant-a",
      id: "same-id",
      committed: { cursor: "1:2", reason: "reload_timeout" },
    });
    expect(client.getQueryData([detail, namespace, "same-id"])).toBeUndefined();
    expect(client.getQueryState([list, namespace, "all"])?.isInvalidated).toBe(true);
  });
}

it("reopens and submits a recreated plugin without retired configuration", async () => {
  await render(<PluginDetailPage />);
  await settle(() => expect(host.querySelector("textarea")?.value).toContain("retired"));
  await render(<Probe kind="membership" />);
  const pending = remove("same-id");
  await settle(() => expect(deletion).toHaveLength(1));
  await act(async () => {
    deletion[0]!.resolve(new Response(null, { status: 204 }));
    await pending;
  });
  serverPlugin = { ...serverPlugin, config: { ordinary: "recreated" }, created_at: "2026-09-06T00:00:00Z" };
  await render(<PluginDetailPage />);
  await settle(() => expect(host.querySelector("textarea")?.value).toContain("recreated"));
  expect(host.querySelector("textarea")?.value).not.toContain("retired");
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ config: { ordinary: "recreated" } });
  expect(serverPlugin.config).toEqual({ ordinary: "recreated" });
});

function ObservedProxyDelete() {
  const mutation = useDeleteProxy();
  const query = useProxy("same-id", !mutation.isPending && !mutation.isSuccess);
  useEffect(() => { remove = (id) => mutation.mutateAsync({ id, guard: null }); });
  return <span data-status={query.status} data-fetch={query.fetchStatus} />;
}

function detailGets(): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => {
    const request = input as Request;
    return request.method === "GET" && new URL(request.url).pathname.endsWith("/proxies/same-id");
  }).length;
}

it("does not refetch a still-mounted proxy detail after a successful delete", async () => {
  client.setQueryData(["proxy", "tenant-a", "same-id"], { id: "same-id" });
  await render(<ObservedProxyDelete />);
  const cancel = vi.spyOn(client, "cancelQueries");
  const removeQueries = vi.spyOn(client, "removeQueries");
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const pending = remove("same-id");
  await settle(() => expect(deletion).toHaveLength(1));
  expect(detailGets()).toBe(0);
  await act(async () => {
    deletion[0]!.resolve(new Response(null, { status: 204 }));
    await pending;
  });
  expect(detailGets()).toBe(0);
  expect(client.getQueryData(["proxy", "tenant-a", "same-id"])).toBeUndefined();
  expect(cancel).toHaveBeenCalledWith({
    queryKey: ["proxy", "tenant-a", "same-id"],
    exact: true,
  });
  expect(removeQueries).toHaveBeenCalledWith({
    queryKey: ["proxy", "tenant-a", "same-id"],
    exact: true,
  });
  expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
    removeQueries.mock.invocationCallOrder[0]!,
  );
  const listInvalidation = invalidate.mock.calls.findIndex(
    (call) => call[0]?.queryKey?.[0] === "proxies",
  );
  expect(listInvalidation).toBeGreaterThanOrEqual(0);
  expect(removeQueries.mock.invocationCallOrder[0]).toBeLessThan(
    invalidate.mock.invocationCallOrder[listInvalidation]!,
  );
});

it("marks cached proxy details stale when a membership plan settles, even on failure", async () => {
  // The plan rewrites proxies' `plugins`; the detail page combines the
  // cached proxy with fresh plugin configs, so it must not keep the old list.
  for (const outcome of [204, 400]) {
    client.setQueryData(["proxy", "tenant-a", "orders"], { id: "orders", plugins: [] });
    await render(<Probe kind="membership" />);
    const pending = remove("same-id").catch((error: unknown) => error);
    await settle(() => expect(deletion).toHaveLength(1));
    await act(async () => {
      deletion.shift()!.resolve(
        outcome === 204 ? new Response(null, { status: 204 }) : new Response("Refused", { status: 400 }),
      );
      await pending;
    });
    expect(client.getQueryState(["proxy", "tenant-a", "orders"])?.isInvalidated, `after ${outcome}`)
      .toBe(true);
    client.clear();
  }
});
