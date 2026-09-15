import type {
  MeshConfigDriftResponse, MeshEgressScopeResponse, MeshPolicyDeniesResponse,
  MeshRemoteClustersResponse, MeshServiceGraphResponse, MeshSliceDriftResponse,
  MeshFederationBundle, NodeWaypointIdentitiesResponse, ServiceWaypointServicesResponse,
} from "@/api/mesh";

export const observedAt = "2026-09-01T00:00:00Z";

// Service-graph fields mirror scripts/mock-admin-gateway.mjs. Other mesh
// responses use the typed admin shapes (the demo gateway returns 404 for them).
export const graph: MeshServiceGraphResponse = {
  generated_at_unix_ms: 1788220800000, generated_at: observedAt, edge_count: 1,
  edges: [{
    source_principal: "spiffe://prod/ns/web/sa/frontend", source_workload: "frontend-7d9",
    source_namespace: "web", source_app: "frontend", source_service: "frontend",
    destination_principal: "spiffe://prod/ns/api/sa/orders", destination_workload: "orders-5f2",
    destination_namespace: "api", destination_app: "orders", destination_service: "orders",
    request_protocol: "http", connection_security_policy: "mutual_tls", requests_total: 48211,
    errors_total: 12, duration_ms_total: 482110, duration_ms_avg: 10,
    last_seen_unix_ms: 1788220800000, last_seen: observedAt,
  }],
};

export const config: MeshConfigDriftResponse = {
  slice: {
    source_protocol: "xds", source_cp_url: "https://cp.example.test", age_seconds: 420,
    version: "slice-v2", fingerprint: "0123456789abcdef0123456789abcdef", resources: { service_entries: 3 },
  },
  convergence: { per_type_versions: {}, missing_required_types: ["LDS"], converged: false, version_skew: true },
  revision: {
    rejected_total: 2, adopted_total: 1, quarantine_active: true,
    quarantined: {
      authority: "cp-primary", sequence: 2, reason: "invalid_policy", consecutive: 2,
      first_seen_at: observedAt, last_seen_at: observedAt,
    },
  },
};

export const slices: MeshSliceDriftResponse = {
  mode: "cp", generated_at: observedAt,
  summary: { tracked: 5, connected: 4, converged: 1, drifted: 1, rejecting: 1, pending: 1, disconnected: 1 },
  data_planes: (["converged", "drifted", "rejecting", "pending", "disconnected"] as const)
    .map((convergence, index) => ({
      node_id: `dp-${convergence}`, namespace: "tenant-a", connected: convergence !== "disconnected",
      session_connected_at: observedAt, convergence,
      ...(index === 0 && { acknowledged: { version: "slice-v2", at: observedAt, age_seconds: 5 } }),
      ...(convergence === "rejecting" && {
        rejected: { version: "slice-v3", at: observedAt, age_seconds: 1, reason: "invalid policy" },
      }),
      drift: { desired_vs_sent: false, desired_vs_acknowledged: index !== 0, sent_vs_acknowledged: index !== 0 },
    })),
};

export const denies: MeshPolicyDeniesResponse = {
  window_seconds: 900, limit: 100, total_denies: 3,
  grouped: [{
    rule: "deny-external", source: "frontend", destination: "outside", reason: "no matching policy",
    count: 3, first_at: observedAt, last_at: observedAt,
  }],
};

export const remote: MeshRemoteClustersResponse = {
  discovery_enabled: true,
  configured: [{
    cluster_name: "west", trust_domain: "west.example.test", network: "private-west",
    control_plane_configured: true, federation_endpoint_configured: true, discovered: true,
    outbound_trust_active: true, inbound_trust_active: false, trust_source: "control_plane",
  }],
  discovered: ["west", "east"].map((name) => ({
    cluster_name: name, trust_domain: `${name}.example.test`, workload_count: 7, service_count: 2,
    fetched_at_unix_seconds: 1788220800, age_seconds: 20,
  })),
};

export const federation: { bundles: MeshFederationBundle[] } = {
  bundles: [{
    cluster: "west", trust_domain: "west.example.test", endpoint: "https://west.example.test/bundle",
    fetched_at_unix_seconds: 1788220800, bundle_age_seconds: 20, x509_authorities: 2, jwt_authorities: 1,
  }],
};

export const egress: MeshEgressScopeResponse = {
  namespace: "tenant-a",
  scope: {
    sidecar_enforced: true, dry_run: false, sidecar_applied: true,
    sidecar_admitted_services: 7, sidecar_denied_services: 2,
    sidecar_admitted_destination_rules: 1, sidecar_denied_destination_rules: 0,
    known_destinations: ["orders.api.svc", "billing.api.svc"],
  },
  health: { sidecar_admitted_services: 7, sidecar_denied_services: 2 },
};

export const identities: NodeWaypointIdentitiesResponse = {
  identity_count: 1, cookies: { orig_dst4: 2, orig_dst6: 3 },
  identities: [{
    pod_uid: "pod-orders", spiffe_id: "spiffe://prod/ns/api/sa/orders", workload_spiffe_hash: 123,
    orig_dst4_cookies: 2, orig_dst6_cookies: 3, has_policy_scope: true,
  }],
};

export const services: ServiceWaypointServicesResponse = {
  waypoint_name: "orders-waypoint", namespace: "api", service_count: 1,
  services: [{ namespace: "api", name: "orders", ports: [80, 443], workload_count: 3 }],
};

export const meshResponses: Record<string, unknown> = {
  "mesh/service-graph": graph,
  "mesh/config-drift": config,
  "mesh/slice-drift": slices,
  "mesh/policy-denies/recent": denies,
  "mesh/remote-clusters": remote,
  "mesh/federation": federation,
  "mesh/egress-scope": egress,
  "node-waypoint/identities": identities,
  "service-waypoint/services": services,
};
