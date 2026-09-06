import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeletePluginConfig, useDeletePluginWithMembership } from "./usePlugins";
import { useDeleteConsumer } from "./useConsumers";
import { useDeleteProxy } from "./useProxies";
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
  plugin: useDeletePluginConfig,
  membership: useDeletePluginWithMembership,
  consumer: useDeleteConsumer,
  proxy: useDeleteProxy,
  upstream: useDeleteUpstream,
};
const cases = [
  ["plugin", "pluginConfig"], ["membership", "pluginConfig"],
  ["consumer", "consumer"], ["proxy", "proxy"], ["upstream", "upstream"],
] as const;
let remove: (id: string) => Promise<unknown>;
function Probe({ kind }: { kind: keyof typeof hooks }) {
  const useDelete = hooks[kind];
  const mutation = useDelete();
  useEffect(() => { remove = mutation.mutateAsync; });
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
