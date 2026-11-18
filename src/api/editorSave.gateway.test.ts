// @vitest-environment node
import { describe, expect, it } from "vitest";
import { signAdminJwt } from "../../shared/admin-jwt.js";
import {
  mergeFormUpdatePayload as mergeProxySave,
  toUpdatePayload as proxyUpdateBody,
} from "./proxies";
import {
  mergeFormUpdatePayload as mergeUpstreamSave,
  toUpdatePayload as upstreamUpdateBody,
} from "./upstreams";
import type { Proxy, Upstream } from "./types";

/*
 * The save payloads the proxy and upstream editors send, against a real
 * gateway (ferrum-edge/ferrum-contracts#76). The contract smoke writes fixture
 * spreads; the editors write `mergeFormUpdatePayload(live, formChanges)`, which
 * fills every form-owned field the form left empty with an explicit clear. A
 * field that builder adds and the gateway no longer accepts (ferrum-foundry
 * #701: `pool_max_requests_per_connection: null`, which Edge main refuses) is
 * caught only by sending that builder's output. The Edge Main Drift workflow
 * runs this file against the Edge `main` image after seeding the demo
 * namespace; ordinary test runs execute only the offline checks.
 */

/** An editor opened on `body` and saved unchanged submits every set field. */
export function unchangedFormChanges<T extends object>(body: T): T {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== null && value !== undefined),
  ) as T;
}

const LIVE_PROXY: Proxy = {
  id: "orders",
  namespace: "ferrum",
  name: "orders",
  listen_path: "/orders",
  hosts: [],
  backend_scheme: "http",
  backend_host: "orders.internal",
  backend_port: 8080,
  strip_listen_path: true,
  preserve_host_header: false,
  backend_connect_timeout_ms: 1_000,
  backend_read_timeout_ms: 2_000,
  backend_write_timeout_ms: 3_000,
  backend_tls_verify_server_cert: true,
  auth_mode: "single",
  plugins: [{ plugin_config_id: "auth" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

describe("unchanged editor saves", () => {
  it("send only writable fields, and none a gateway removed (#701)", () => {
    const payload = mergeProxySave(LIVE_PROXY, unchangedFormChanges(proxyUpdateBody(LIVE_PROXY)));
    expect(payload).not.toHaveProperty("pool_max_requests_per_connection");
    expect(payload).not.toHaveProperty("plugins");
    expect(payload).not.toHaveProperty("created_at");
    expect(payload.backend_host).toBe("orders.internal");
    // A form-owned optional the live row leaves unset goes out as a clear.
    expect(payload.retry).toBeNull();
    // Even when an older gateway's read still carries the retired field.
    const stale = { ...LIVE_PROXY, pool_max_requests_per_connection: 900 } as Proxy;
    expect(mergeProxySave(stale, unchangedFormChanges(proxyUpdateBody(stale)))).not.toHaveProperty(
      "pool_max_requests_per_connection",
    );
  });

  it("drop nulls and undefined only", () => {
    expect(unchangedFormChanges({ a: 1, b: null, c: undefined, d: false, e: "" })).toEqual({
      a: 1,
      d: false,
      e: "",
    });
  });
});

const GATEWAY = process.env.FERRUM_EDITOR_SAVE_GATEWAY_CONTRACT === "true";

it.runIf(GATEWAY)(
  "the gateway accepts every unchanged proxy and upstream editor save",
  async () => {
    const adminUrl = process.env.FERRUM_ADMIN_URL!;
    const namespace = process.env.FERRUM_NAMESPACE!;
    const token = await signAdminJwt({
      secret: process.env.FERRUM_JWT_SECRET!,
      issuer: process.env.FERRUM_JWT_ISSUER ?? "ferrum-edge",
      subject: "foundry-editor-save-contract",
      role: "admin",
      namespaces: [namespace],
      audience: process.env.FERRUM_JWT_AUDIENCE,
      ttlSeconds: 600,
    });
    async function exchange(path: string, init: { method?: string; body?: unknown; etag?: string } = {}) {
      const response = await fetch(new URL(path, adminUrl), {
        method: init.method ?? "GET",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-ferrum-namespace": namespace,
          ...(init.etag ? { "if-match": init.etag } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: response.status, etag: response.headers.get("etag"), text: await response.text() };
    }
    async function rows<T>(collection: string): Promise<T[]> {
      const answer = await exchange(`/${collection}?limit=1000`);
      expect(answer.status, `GET /${collection}: ${answer.text.slice(0, 500)}`).toBe(200);
      return (JSON.parse(answer.text) as { data: T[] }).data;
    }

    const proxies = await rows<Proxy>("proxies");
    const upstreams = await rows<Upstream>("upstreams");
    expect(proxies.length, "the demo seed ran first").toBeGreaterThan(0);
    expect(upstreams.length, "the demo seed ran first").toBeGreaterThan(0);

    const refused: string[] = [];
    async function save(kind: "proxies" | "upstreams", id: string, build: (live: never) => unknown) {
      // As the editor does: read the row with its validator, then replace it.
      const read = await exchange(`/${kind}/${encodeURIComponent(id)}`);
      expect(read.status, `GET /${kind}/${id}`).toBe(200);
      const body = build(JSON.parse(read.text) as never);
      const write = await exchange(`/${kind}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body,
        etag: read.etag ?? undefined,
      });
      if (write.status !== 200) refused.push(`PUT /${kind}/${id} -> ${write.status}: ${write.text.slice(0, 500)}`);
    }
    for (const proxy of proxies) {
      await save("proxies", proxy.id, (live: Proxy) =>
        mergeProxySave(live, unchangedFormChanges(proxyUpdateBody(live))),
      );
    }
    for (const upstream of upstreams) {
      await save("upstreams", upstream.id, (live: Upstream) =>
        mergeUpstreamSave(live, unchangedFormChanges(upstreamUpdateBody(live))),
      );
    }
    expect(refused, "editor saves the gateway refused").toEqual([]);

    // The check has teeth only while the gateway refuses a field it does not
    // know, which is what turns a removed field into a refused save.
    const probe = proxies[0];
    const read = await exchange(`/proxies/${encodeURIComponent(probe.id)}`);
    const unknownField = await exchange(`/proxies/${encodeURIComponent(probe.id)}`, {
      method: "PUT",
      body: { ...proxyUpdateBody(JSON.parse(read.text) as Proxy), foundry_unknown_field_probe: null },
      etag: read.etag ?? undefined,
    });
    expect(unknownField.status, unknownField.text.slice(0, 500)).toBe(400);
  },
  120_000,
);
