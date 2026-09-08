/* ------------------------------------------------------------------ */
/*  Cache retirement for mutations whose gateway effect cascades       */
/*  across resource types (issue #301, extending #240).                */
/* ------------------------------------------------------------------ */

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeleteApiSpec, useImportApiSpec, useUpdateApiSpec } from "./useApiSpecs";
import { useDeleteProxy } from "./useProxies";
import type { Proxy } from "@/api/types";
import ProxyDetailPage from "@/routes/proxies/$proxyId";

let namespace: string;
vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: namespace, scope: { namespace } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ proxyId: "spec-proxy" }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

function specProxy(listenPath: string): Proxy {
  return {
    id: "spec-proxy",
    namespace: "tenant-a",
    name: "spec proxy",
    listen_path: listenPath,
    hosts: [],
    backend_scheme: "https",
    backend_host: "backend.example.com",
    backend_port: 443,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 1_000,
    backend_read_timeout_ms: 2_000,
    backend_write_timeout_ms: 3_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: true,
    passthrough: false,
    udp_idle_timeout_seconds: 60,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    api_spec_id: "spec-1",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

let run: (id: string) => Promise<unknown>;

/* Each cascading mutation gets its own probe component so the hook call is a
   plain hook call, as the rules-of-hooks lint requires. */
function ImportProbe() {
  const mutation = useImportApiSpec();
  useEffect(() => {
    run = (id) => mutation.mutateAsync(`openapi: 3.0.0 # ${id}`);
  });
  return null;
}

function ReplaceProbe() {
  const mutation = useUpdateApiSpec();
  useEffect(() => {
    run = (id) => mutation.mutateAsync({ id, document: "openapi: 3.0.0" });
  });
  return null;
}

function DeleteSpecProbe() {
  const mutation = useDeleteApiSpec();
  useEffect(() => {
    run = (id) => mutation.mutateAsync(id);
  });
  return null;
}

function DeleteProxyProbe() {
  const mutation = useDeleteProxy();
  useEffect(() => {
    run = (id) => mutation.mutateAsync(id);
  });
  return null;
}

const probes = {
  import: ImportProbe,
  replace: ReplaceProbe,
  deleteSpec: DeleteSpecProbe,
  deleteProxy: DeleteProxyProbe,
};

// `deleteProxy` cascades to other resource types but keeps #240's exact-id
// retirement for proxies, so a sibling proxy's detail entry must survive it.
const cases = [
  ["import", ["proxy", "upstream", "pluginConfig", "apiSpecDocument"]],
  ["replace", ["proxy", "upstream", "pluginConfig", "apiSpecDocument"]],
  ["deleteSpec", ["proxy", "upstream", "pluginConfig", "apiSpecDocument"]],
  ["deleteProxy", ["upstream", "pluginConfig", "apiSpecDocument"]],
] as const;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let writes: { namespace: string | null; resolve: (response: Response) => void }[];
let serverProxy: Proxy;
let updates: unknown[];

beforeEach(() => {
  namespace = "tenant-a";
  writes = [];
  updates = [];
  serverProxy = specProxy("/v1");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" || request.method === "DELETE") {
        return new Promise<Response>((resolve) =>
          writes.push({ namespace: request.headers.get("X-Ferrum-Namespace"), resolve }),
        );
      }
      if (request.method === "PUT" && path.includes("/api-specs/")) {
        return new Promise<Response>((resolve) =>
          writes.push({ namespace: request.headers.get("X-Ferrum-Namespace"), resolve }),
        );
      }
      if (request.method === "PUT") {
        const data = (await request.json()) as Partial<Proxy>;
        updates.push(data);
        serverProxy = { ...serverProxy, ...data };
        return Response.json(serverProxy);
      }
      if (path.endsWith("/proxies/spec-proxy")) return Response.json(serverProxy);
      return Response.json({ data: [], pagination: { offset: 0, limit: 250, total: 0 } });
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
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
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  );
}

async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
  });
}

const specResponse = () =>
  Response.json({
    id: "spec-1",
    proxy_id: "spec-proxy",
    spec_version: "2",
    content_hash: "sha256:2",
  });

function seedDetails() {
  for (const kind of ["proxy", "upstream", "pluginConfig", "apiSpecDocument"]) {
    for (const scope of ["tenant-a", "tenant-b"]) {
      client.setQueryData([kind, scope, "cascaded-id"], { preserved: `${scope}:${kind}` });
    }
  }
}

for (const [kind, retired] of cases) {
  describe(`${kind} cascade retirement`, () => {
    it("retires the cascaded detail entries of the originating namespace only", async () => {
      const Probe = probes[kind];
      seedDetails();
      await render(<Probe />);
      const pending = run("spec-1");
      await settle(() => expect(writes).toHaveLength(1));

      // A switch after the click must not retarget the retirement.
      namespace = "tenant-b";
      await render(<Probe />);
      const settled =
        kind === "deleteProxy" ? new Response(null, { status: 204 }) : specResponse();
      await act(async () => {
        writes[0]!.resolve(settled);
        await pending;
      });

      expect(writes[0]!.namespace).toBe("tenant-a");
      for (const detail of retired) {
        expect(client.getQueryData([detail, "tenant-a", "cascaded-id"])).toBeUndefined();
        expect(client.getQueryData([detail, "tenant-b", "cascaded-id"])).toBeDefined();
      }
    });

    it("retains the cascaded details when the mutation fails", async () => {
      const Probe = probes[kind];
      seedDetails();
      await render(<Probe />);
      const pending = run("spec-1").catch((error: unknown) => error);
      await settle(() => expect(writes).toHaveLength(1));
      await act(async () => {
        writes[0]!.resolve(new Response("Refused", { status: 400 }));
        await pending;
      });

      for (const detail of retired) {
        expect(client.getQueryData([detail, "tenant-a", "cascaded-id"])).toEqual({
          preserved: `tenant-a:${detail}`,
        });
      }
    });
  });
}

it("keeps a sibling proxy's detail entry when one proxy is deleted", async () => {
  client.setQueryData(["proxy", "tenant-a", "spec-proxy"], { preserved: true });
  client.setQueryData(["proxy", "tenant-a", "other-proxy"], { preserved: true });
  await render(<DeleteProxyProbe />);
  const pending = run("spec-proxy");
  await settle(() => expect(writes).toHaveLength(1));
  await act(async () => {
    writes[0]!.resolve(new Response(null, { status: 204 }));
    await pending;
  });

  expect(client.getQueryData(["proxy", "tenant-a", "spec-proxy"])).toBeUndefined();
  expect(client.getQueryData(["proxy", "tenant-a", "other-proxy"])).toBeDefined();
});

it("reopens and submits a spec-replaced proxy without pre-replacement values", async () => {
  const listenPath = () =>
    (host.querySelector('input[placeholder="/api/v1"]') as HTMLInputElement | null)?.value;

  await render(<ProxyDetailPage />);
  await settle(() => expect(listenPath()).toBe("/v1"));

  // The gateway deletes and re-creates the spec-owned proxy under the same id.
  await render(<ReplaceProbe />);
  const pending = run("spec-1");
  await settle(() => expect(writes).toHaveLength(1));
  serverProxy = specProxy("/v2");
  await act(async () => {
    writes[0]!.resolve(specResponse());
    await pending;
  });

  await render(<ProxyDetailPage />);
  await settle(() => expect(listenPath()).toBe("/v2"));

  // Update with no edit must not PUT the superseded document's values back.
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ listen_path: "/v2" });
  expect(serverProxy.listen_path).toBe("/v2");
});
