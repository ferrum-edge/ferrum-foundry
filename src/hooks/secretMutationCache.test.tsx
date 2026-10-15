/* ------------------------------------------------------------------ */
/*  A restore's backup and an API spec write's document carry secrets */
/*  (#485). Their mutations keep the submitted body as `variables`,   */
/*  so each is discarded from the mutation cache as soon as the page  */
/*  that submitted it is gone, like the other secret-bearing writes.  */
/* ------------------------------------------------------------------ */

import { act, useEffect, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, settle, stubFetch } from "@/test/__tests__/harness";
import * as plugins from "@/api/plugins";
import * as proxies from "@/api/proxies";
import * as upstreams from "@/api/upstreams";
import type { PluginConfig, Proxy, Upstream } from "@/api/types";
import { useImportApiSpec, useUpdateApiSpec } from "./useApiSpecs";
import { useRestore } from "./useOps";
import { useDeletePluginWithMembership } from "./usePlugins";
import { useDeleteProxy } from "./useProxies";
import { useDeleteUpstream } from "./useUpstreams";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

const SECRET = "synthetic-secret-0123456789";
const BACKUP = { version: "1", consumers: [{ id: "alice", credentials: { keyauth: [{ key: SECRET }] } }] };
const DOCUMENT = `x-ferrum-plugins:\n  - plugin_name: key_auth\n    config:\n      api_key: ${SECRET}\n`;

let ui: ReturnType<typeof createHarness>;
let submit: () => Promise<unknown>;

function RestoreProbe() {
  const mutation = useRestore();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ data: BACKUP, namespace: "tenant-a" });
  });
  return <p>probe</p>;
}

function ImportProbe() {
  const mutation = useImportApiSpec();
  useEffect(() => {
    submit = () => mutation.mutateAsync(DOCUMENT);
  });
  return <p>probe</p>;
}

function ReplaceProbe() {
  const mutation = useUpdateApiSpec();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ id: "orders-spec", document: DOCUMENT });
  });
  return <p>probe</p>;
}

/* A guarded delete's variables hold the editor's baseline, which can carry an
   inline backend TLS key (#612). */
const PEM_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7syntheticAAAA";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\n-----END PRIVATE KEY-----\n`;
const PROXY = {
  id: "edge", backend_host: "backend.internal", backend_port: 443,
  backend_tls_client_key_path: PEM,
} as unknown as Proxy;
const UPSTREAM = {
  id: "edge", name: "edge", algorithm: "round_robin", targets: [],
  backend_tls_client_key_path: PEM,
} as unknown as Upstream;
const PLUGIN = {
  id: "edge", plugin_name: "mesh_route_dispatch", scope: "global", enabled: true,
  config: { rules: [{ destination: { backend_tls: { client_key_path: PEM } } }] },
} as unknown as PluginConfig;

function ProxyDeleteProbe() {
  const mutation = useDeleteProxy();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ id: "edge", guard: proxies.proxyWriteGuard(PROXY) });
  });
  return <p>probe</p>;
}

function UpstreamDeleteProbe() {
  const mutation = useDeleteUpstream();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ id: "edge", guard: upstreams.upstreamWriteGuard(UPSTREAM) });
  });
  return <p>probe</p>;
}

function PluginDeleteProbe() {
  const mutation = useDeletePluginWithMembership();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ id: "edge", guard: plugins.pluginWriteGuard(PLUGIN) });
  });
  return <p>probe</p>;
}

/** A gateway holding `current` at `…/edge` with a strong tag, deleting with `204`. */
function stubGateway(current: object) {
  stubFetch((request) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (new URL(request.url).pathname.endsWith("/edge")) {
      return Response.json(current, { headers: { ETag: '"r1"' } });
    }
    return Response.json({ data: [], pagination: { offset: 0, limit: 250, total: 0 } });
  });
}

beforeEach(() => {
  ui = createHarness();
  stubFetch(() => Response.json({ error: "rejected" }, { status: 400 }));
});

afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

describe("secret-bearing mutations leave nothing in the mutation cache", () => {
  it.each<[string, ComponentType]>([
    ["a restore", RestoreProbe],
    ["an API spec import", ImportProbe],
    ["an API spec replacement", ReplaceProbe],
  ])("discards %s once its page is gone", async (_label, Probe) => {
    await ui.render(<Probe />);
    await act(async () => { await submit().catch(() => undefined); });
    // The page that submitted it can still report the failure.
    const [mutation] = ui.client.getMutationCache().getAll();
    expect(mutation?.state.status).toBe("error");
    expect(JSON.stringify(mutation?.state.variables)).toContain(SECRET);

    await ui.render(<p>elsewhere</p>);
    await settle(() => expect(ui.client.getMutationCache().getAll()).toHaveLength(0));
  });
});

describe("guarded deletes leave no baseline in the mutation cache (#612)", () => {
  it.each<[string, ComponentType, object]>([
    ["a proxy", ProxyDeleteProbe, PROXY],
    ["an upstream", UpstreamDeleteProbe, UPSTREAM],
    ["a plugin configuration", PluginDeleteProbe, PLUGIN],
  ])("discards %s delete once its page is gone, deleted or refused", async (_label, Probe, seed) => {
    for (const [current, status] of [[seed, "success"], [{ ...seed, moved: true }, "error"]] as const) {
      stubGateway(current);
      await ui.render(<Probe />);
      await act(async () => { await submit().catch(() => undefined); });
      const [mutation] = ui.client.getMutationCache().getAll();
      expect(mutation?.state.status).toBe(status);
      expect(JSON.stringify(mutation?.state.variables)).toContain(PEM_LINE);

      await ui.render(<p>elsewhere</p>);
      await settle(() => expect(ui.client.getMutationCache().getAll()).toHaveLength(0));
    }
  });
});
