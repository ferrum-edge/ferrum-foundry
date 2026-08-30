import { describe, expect, it } from "vitest";
import type { Upstream } from "./types";
import { mergeFormUpdatePayload, toUpdatePayload } from "./upstreams";

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
