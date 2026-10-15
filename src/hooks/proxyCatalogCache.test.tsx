/* ------------------------------------------------------------------ */
/*  Issue #611: a proxy write invalidates the cached full proxy list,  */
/*  but a disabled query is not refetched. The picker's catalog must   */
/*  prefer its freshly fetched first page over that entry, and must    */
/*  not let it claim completeness and hide "Search all".               */
/* ------------------------------------------------------------------ */

import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGatewayMetadata } from "@/api/gatewayMetadata";
import type { Proxy, ProxyCreate } from "@/api/types";
import { createHarness, settle, stubFetch } from "@/test/__tests__/harness";
import {
  useCreateProxy,
  useDeleteProxy,
  useProxyCatalog,
  useUpdateProxy,
} from "./useProxies";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

const ALL_KEY = ["proxies", "tenant-a", "all"];

function proxy(id: string, name = id): Proxy {
  return {
    id, name, listen_path: `/${id}`, backend_scheme: "http", backend_host: "localhost", backend_port: 8080,
    hosts: [], strip_listen_path: false, preserve_host_header: false,
    backend_connect_timeout_ms: 5000, backend_read_timeout_ms: 5000, backend_write_timeout_ms: 5000,
    backend_tls_verify_server_cert: true, auth_mode: "single", frontend_tls: false, passthrough: false,
    udp_idle_timeout_seconds: 60, allowed_ws_origins: [], response_body_mode: "stream", plugins: [],
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
}

let ui: ReturnType<typeof createHarness>;
/** The gateway's proxy collection. */
let rows: Proxy[];
/** The most rows the gateway returns per page, so a test can make the first page partial. */
let pageCap: number;
let fetchMock: ReturnType<typeof stubFetch>;
let create: (data: ProxyCreate) => Promise<unknown>;
let rename: (id: string, name: string) => Promise<unknown>;
let remove: (id: string) => Promise<unknown>;

function Mutations() {
  const created = useCreateProxy();
  const updated = useUpdateProxy();
  const deleted = useDeleteProxy();
  useEffect(() => {
    create = (data) => created.mutateAsync(data);
    rename = (id, name) => updated.mutateAsync({
      id, data: { ...rows.find((entry) => entry.id === id)!, name }, guard: null,
    });
    remove = (id) => deleted.mutateAsync({ id, guard: null });
  });
  return null;
}

function Catalog({ expanded }: { expanded: boolean }) {
  const catalog = useProxyCatalog(expanded);
  return (
    <output
      data-names={catalog.proxies.map((entry) => entry.name).join(",")}
      data-total={catalog.total}
      data-complete={String(catalog.complete)}
      data-expanding={String(catalog.expanding)}
    />
  );
}

function catalog() {
  const output = ui.host.querySelector("output");
  expect(output).not.toBeNull();
  return {
    names: output!.dataset.names,
    total: Number(output!.dataset.total),
    complete: output!.dataset.complete === "true",
    expanding: output!.dataset.expanding === "true",
  };
}

const proxyListReads = () => fetchMock.mock.calls.filter(([request]) =>
  request.method === "GET" && new URL(request.url).pathname === "/api/proxy/proxies").length;

beforeEach(() => {
  ui = createHarness();
  rows = [];
  pageCap = Number.POSITIVE_INFINITY;
  clearGatewayMetadata();
  fetchMock = stubFetch(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/proxy/proxies" && request.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 250), pageCap);
      return Response.json({
        data: rows.slice(offset, offset + limit),
        pagination: { offset, limit, total: rows.length },
      });
    }
    if (path === "/api/proxy/proxies" && request.method === "POST") {
      const body = await request.json() as ProxyCreate & { id: string };
      const created = { ...proxy(body.id), ...body };
      rows = [...rows, created];
      return Response.json(created, { status: 201 });
    }
    const id = decodeURIComponent(path.replace("/api/proxy/proxies/", ""));
    if (request.method === "PUT") {
      const body = await request.json() as ProxyCreate;
      rows = rows.map((entry) => (entry.id === id ? { ...entry, ...body } : entry));
      return Response.json(rows.find((entry) => entry.id === id));
    }
    if (request.method === "DELETE") {
      rows = rows.filter((entry) => entry.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
});

afterEach(async () => {
  await ui.dispose();
  clearGatewayMetadata();
  vi.unstubAllGlobals();
});

/** Cache a full list, as an earlier proxy-list search leaves behind. */
function seedFullList(list: Proxy[]) {
  ui.client.setQueryData(ALL_KEY, list);
}

/** Run a write while no full-list observer is mounted, then open the picker. */
async function writeThenOpenPicker(write: () => Promise<unknown>) {
  await ui.render(<Mutations />);
  await act(async () => { await write(); });
  // The write retired the entry, but nothing observes it, so it still holds
  // the pre-write rows.
  expect(ui.client.getQueryState(ALL_KEY)?.isInvalidated).toBe(true);
  await ui.render(<><Mutations /><Catalog expanded={false} /></>);
}

describe("useProxyCatalog after an invalidating write (#611)", () => {
  it("shows a created proxy from the fresh first page", async () => {
    rows = [proxy("old")];
    seedFullList([proxy("old")]);

    await writeThenOpenPicker(() => create({ id: "new", name: "new", backend_host: "localhost", backend_port: 8080 }));

    await settle(() => expect(catalog()).toEqual({
      names: "old,new", total: 2, complete: true, expanding: false,
    }));
    expect(ui.client.getQueryData(ALL_KEY)).toEqual([proxy("old")]);
  });

  it("offers Search all after a create, and the search refetches the stale full list", async () => {
    rows = [proxy("old")];
    pageCap = 1;
    seedFullList([proxy("old")]);

    await writeThenOpenPicker(() => create({ id: "new", name: "new", backend_host: "localhost", backend_port: 8080 }));

    // The first page holds one of two proxies, so the picker must say it is
    // partial and offer the traversal rather than trust the one-row cache.
    await settle(() => expect(catalog()).toEqual({
      names: "old", total: 2, complete: false, expanding: false,
    }));

    const before = proxyListReads();
    await ui.render(<><Mutations /><Catalog expanded /></>);
    await settle(() => expect(catalog()).toEqual({
      names: "old,new", total: 2, complete: true, expanding: false,
    }));
    expect(proxyListReads()).toBeGreaterThan(before);
    expect(ui.client.getQueryState(ALL_KEY)?.isInvalidated).toBe(false);
  });

  it("shows a renamed proxy's new name", async () => {
    rows = [proxy("one", "before"), proxy("two")];
    seedFullList([proxy("one", "before"), proxy("two")]);

    await writeThenOpenPicker(() => rename("one", "after"));

    await settle(() => expect(catalog()).toEqual({
      names: "after,two", total: 2, complete: true, expanding: false,
    }));
  });

  it("drops a deleted proxy", async () => {
    rows = [proxy("kept"), proxy("gone")];
    seedFullList([proxy("kept"), proxy("gone")]);

    await writeThenOpenPicker(() => remove("gone"));

    await settle(() => expect(catalog()).toEqual({
      names: "kept", total: 1, complete: true, expanding: false,
    }));
  });
});

describe("useProxyCatalog full list", () => {
  it("uses a freshly traversed full list when expanded, and keeps it once collapsed", async () => {
    rows = [proxy("a"), proxy("b"), proxy("c")];
    pageCap = 1;

    await ui.render(<Catalog expanded={false} />);
    await settle(() => expect(catalog()).toEqual({
      names: "a", total: 3, complete: false, expanding: false,
    }));

    await ui.render(<Catalog expanded />);
    await settle(() => expect(catalog()).toEqual({
      names: "a,b,c", total: 3, complete: true, expanding: false,
    }));

    // The full list is valid and newer than the first page, so it still answers.
    await ui.render(<Catalog expanded={false} />);
    await settle(() => expect(catalog()).toEqual({
      names: "a,b,c", total: 3, complete: true, expanding: false,
    }));
  });
});
