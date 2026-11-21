import { describe, expect, it } from "vitest";
import type { Upstream } from "./types";
import { compareBaselines } from "@/lib/resourceBaseline";
import {
  mergeFormUpdatePayload,
  toBaseline,
  toUpdatePayload,
  writableSubset,
} from "./upstreams";

function fullUpstream(): Upstream {
  return {
    id: "upstream-1",
    namespace: "ferrum",
    name: "payments",
    algorithm: "consistent_hashing",
    hash_on: "cookie:route",
    targets: [{
      host: "10.0.0.1",
      port: 8443,
      weight: 2,
      tags: { version: "v2" },
      locality: "us-east-1/a",
      path: "/api",
    }],
    hash_on_cookie_config: {
      path: "/",
      ttl_seconds: 60,
      session_cookie: true,
      http_only: true,
    },
    health_checks: {
      active: { probe_type: "http", http_path: "/ready", interval_seconds: 5 },
      passive: { unhealthy_threshold: 3, max_ejection_percent: 50 },
    },
    service_discovery: {
      provider: "kubernetes",
      kubernetes: {
        service_name: "payments",
        namespace: "prod",
        label_selector: "tier=backend",
        poll_interval_seconds: 15,
      },
      default_weight: 3,
      max_stale_seconds: 120,
      stale_policy: "fail_readiness",
    },
    subsets: [{
      name: "v2",
      labels: { version: "v2" },
      traffic_policy: {
        load_balancer_algorithm: "least_latency",
        hash_on: "header:x-user",
      },
    }],
    backend_tls_verify_server_cert: true,
    backend_tls_client_cert_path: "/tls/client.pem",
    backend_tls_client_key_path: "/tls/client.key",
    backend_tls_server_ca_cert_path: "/tls/ca.pem",
    backend_tls_sni: "payments.internal",
    backend_tls_san_allow_list: ["payments.internal"],
    port_overrides: { http: 8443 },
    source_locality: "us-east-1",
    source_labels: { cluster: "blue" },
    locality_lb_setting: { failover: true },
    locality_lb_strict: true,
    api_spec_id: "spec-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
}

describe("upstream full-replacement builders", () => {
  it("strips server and mesh projections only", () => {
    const payload = toUpdatePayload(fullUpstream());
    expect(payload).not.toHaveProperty("namespace");
    expect(payload).not.toHaveProperty("port_overrides");
    expect(payload).not.toHaveProperty("source_locality");
    expect(payload.backend_tls_sni).toBe("payments.internal");
  });

  it("strips the server-owned subset traffic_policy fields and keeps every writable one", () => {
    const read = {
      ...fullUpstream(),
      subsets: [
        {
          name: "v2",
          labels: { version: "v2" },
          traffic_policy: {
            load_balancer_algorithm: "least_latency",
            hash_on: "header:x-user",
            future_policy_field: "kept",
            tls: { mode: "simple", insecure_skip_verify: false, private_key: "[REDACTED]" },
            connect_timeout_ms: 1500,
            max_retries: 1,
            passive_health_check: { unhealthy_threshold: 5 },
          },
        },
        { name: "v3", labels: { version: "v3" }, traffic_policy: { http2_max_requests: 10 } },
        { name: "v4", labels: { version: "v4" }, traffic_policy: null },
        { name: "v5", labels: { version: "v5" } },
      ],
    } as unknown as Upstream;
    expect(toUpdatePayload(read).subsets).toEqual([
      {
        name: "v2",
        labels: { version: "v2" },
        traffic_policy: {
          load_balancer_algorithm: "least_latency",
          hash_on: "header:x-user",
          future_policy_field: "kept",
        },
      },
      { name: "v3", labels: { version: "v3" } },
      { name: "v4", labels: { version: "v4" }, traffic_policy: null },
      { name: "v5", labels: { version: "v5" } },
    ]);
    // The read itself is not changed.
    expect(read.subsets?.[0].traffic_policy?.tls).toBeDefined();
    const kept = { name: "v5", labels: { version: "v5" } };
    expect(writableSubset(kept)).toBe(kept);
  });

  it("preserves advanced nested policy during a reduced form edit", () => {
    const payload = mergeFormUpdatePayload(fullUpstream(), {
      name: "payments-v2",
      algorithm: "round_robin",
      targets: [{
        host: "10.0.0.2",
        port: 9443,
        weight: 1,
        tags: { version: "v2" },
        locality: "us-east-1/a",
        path: "/api",
      }],
      hash_on_cookie_config: {
        path: "/new",
        ttl_seconds: 60,
        session_cookie: true,
        http_only: true,
      },
      service_discovery: {
        provider: "kubernetes",
        kubernetes: {
          service_name: "payments-v2",
          namespace: "prod",
          label_selector: "tier=backend",
          poll_interval_seconds: 15,
        },
        default_weight: 3,
        max_stale_seconds: 120,
        stale_policy: "fail_readiness",
      },
      subsets: [{
        name: "v2",
        labels: { version: "v2" },
        traffic_policy: {
          load_balancer_algorithm: "least_latency",
          hash_on: "header:x-user",
        },
      }],
      backend_tls_verify_server_cert: true,
      backend_tls_client_cert_path: "/tls/client.pem",
      backend_tls_client_key_path: "/tls/client.key",
      backend_tls_server_ca_cert_path: "/tls/ca.pem",
      backend_tls_sni: "payments.internal",
      backend_tls_san_allow_list: ["payments.internal"],
    });

    expect(payload.targets[0]).toMatchObject({
      host: "10.0.0.2",
      locality: "us-east-1/a",
      tags: { version: "v2" },
    });
    expect(payload.hash_on_cookie_config?.session_cookie).toBe(true);
    expect(payload.service_discovery).toMatchObject({
      max_stale_seconds: 120,
      stale_policy: "fail_readiness",
      kubernetes: { label_selector: "tier=backend" },
    });
    expect(payload.subsets?.[0].traffic_policy).toEqual({
      load_balancer_algorithm: "least_latency",
      hash_on: "header:x-user",
    });
    expect(payload.backend_tls_sni).toBe("payments.internal");
    expect(payload.backend_tls_san_allow_list).toEqual(["payments.internal"]);
  });

  it("keeps explicit target and subset removals", () => {
    const payload = mergeFormUpdatePayload(fullUpstream(), {
      algorithm: "round_robin",
      targets: [],
      subsets: [],
    });
    expect(payload.targets).toEqual([]);
    expect(payload.subsets).toEqual([]);
  });
});

describe("upstream baselines (#725)", () => {
  function meshUpstream(policy: Record<string, unknown>): Upstream {
    return {
      ...fullUpstream(),
      subsets: [
        {
          name: "v2",
          labels: { version: "v2" },
          traffic_policy: { load_balancer_algorithm: "least_latency", ...policy },
        },
        { name: "v3", labels: { version: "v3" }, traffic_policy: { connect_timeout_ms: 1 } },
      ],
    } as Upstream;
  }

  it("leaves the server-owned subset traffic_policy fields out, as the payload does", () => {
    const read = meshUpstream({ tls: { mode: "simple" }, connect_timeout_ms: 1_000 });
    expect(toBaseline(read).subsets).toEqual([
      { name: "v2", labels: { version: "v2" }, traffic_policy: { load_balancer_algorithm: "least_latency" } },
      { name: "v3", labels: { version: "v3" } },
    ]);
    expect(toBaseline(read)).toEqual(toBaseline(toUpdatePayload(read)));
    // The read itself is not changed.
    expect(read.subsets?.[0].traffic_policy?.tls).toEqual({ mode: "simple" });
  });

  it("is unchanged by a control-plane rewrite of a server-owned field", () => {
    const original = toBaseline(meshUpstream({ tls: { mode: "simple" }, connect_timeout_ms: 1_000 }));
    const current = toBaseline(
      meshUpstream({ tls: { mode: "mutual" }, connect_timeout_ms: 2_500, max_retries: 3 }),
    );
    expect(current).toEqual(original);
  });

  it("does not mark subsets changed locally in a conflict on another field", () => {
    const read = meshUpstream({ tls: { mode: "simple" }, connect_timeout_ms: 1_000 });
    const original = toBaseline(read);
    const current = toBaseline({
      ...meshUpstream({ tls: { mode: "mutual" } }),
      algorithm: "least_connections",
    });
    const proposed = toBaseline(mergeFormUpdatePayload(read, toUpdatePayload(read)));
    expect(compareBaselines(original, current, proposed)).toEqual([
      expect.objectContaining({ field: "algorithm", changedLocally: false }),
    ]);
  });

  it("keeps a writable subset change", () => {
    const original = toBaseline(meshUpstream({}));
    const current = toBaseline(meshUpstream({ load_balancer_algorithm: "round_robin" }));
    expect(current).not.toEqual(original);
  });

  it("keeps malformed subset entries and policies verbatim", () => {
    const read = {
      ...fullUpstream(),
      subsets: [null, "v1", { name: "v2", labels: {}, traffic_policy: "broken" }, ["v3"]],
    } as unknown as Upstream;
    expect(toBaseline(read).subsets).toEqual(read.subsets);
  });

  it("treats an explicit null subset policy as an omitted one", () => {
    const read = {
      ...fullUpstream(),
      subsets: [{ name: "v2", labels: { version: "v2" }, traffic_policy: null }],
    } as Upstream;
    expect(toBaseline(read).subsets).toEqual([{ name: "v2", labels: { version: "v2" } }]);
    // The settings form submits no policy key for it, renamed or not.
    const original = toBaseline(read);
    const current = toBaseline({ ...read, algorithm: "least_connections" });
    const proposed = toBaseline(
      mergeFormUpdatePayload(read, {
        ...toUpdatePayload(read),
        name: "payments-v2",
        subsets: [{ name: "v2", labels: { version: "v2" } }],
      }),
    );
    expect(compareBaselines(original, current, proposed).map(({ field }) => field).sort())
      .toEqual(["algorithm", "name"]);
  });

  it("treats a null algorithm or hash key inside a subset policy as unset", () => {
    const read = {
      ...fullUpstream(),
      subsets: [
        { name: "a", labels: {}, traffic_policy: { load_balancer_algorithm: null, hash_on: null } },
        { name: "b", labels: {}, traffic_policy: { load_balancer_algorithm: null, hash_on: "header:x" } },
        { name: "c", labels: {}, traffic_policy: { hash_on: null, future_policy_field: null } },
        { name: "d", labels: {}, traffic_policy: { hash_on: null, connect_timeout_ms: 5 } },
      ],
    } as unknown as Upstream;
    expect(toBaseline(read).subsets).toEqual([
      { name: "a", labels: {} },
      { name: "b", labels: {}, traffic_policy: { hash_on: "header:x" } },
      // A field the form does not model keeps its explicit null.
      { name: "c", labels: {}, traffic_policy: { future_policy_field: null } },
      { name: "d", labels: {} },
    ]);
  });

  it("compares an empty subset hash key as the client-IP key it means", () => {
    const withKey = (hash_on: string) => ({
      ...fullUpstream(),
      subsets: [{ name: "a", labels: {}, traffic_policy: { hash_on } }],
    }) as Upstream;
    expect(toBaseline(withKey("")).subsets).toEqual([
      { name: "a", labels: {}, traffic_policy: { hash_on: "ip" } },
    ]);
    expect(toBaseline(withKey(""))).toEqual(toBaseline(withKey("ip")));
    expect(toBaseline(withKey(""))).not.toEqual(toBaseline({ ...withKey(""), subsets: [{ name: "a", labels: {} }] }));
  });
});
