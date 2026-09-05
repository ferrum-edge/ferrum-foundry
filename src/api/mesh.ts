/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – mesh observability API                            */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, type NamespaceScope } from "./client";

/* ---------- Service graph ---------- */

export interface MeshServiceGraphEdge {
  source_principal: string;
  source_workload: string;
  source_namespace: string;
  source_app: string;
  source_service: string;
  destination_principal: string;
  destination_workload: string;
  destination_namespace: string;
  destination_app: string;
  destination_service: string;
  request_protocol: string;
  connection_security_policy: string;
  requests_total: number;
  errors_total: number;
  duration_ms_total: number;
  duration_ms_avg: number;
  last_seen_unix_ms: number;
  last_seen: string;
}

export interface MeshServiceGraphResponse {
  generated_at_unix_ms: number;
  generated_at: string;
  edge_count: number;
  edges: MeshServiceGraphEdge[];
}

export async function getServiceGraph(
  scope: NamespaceScope,
): Promise<MeshServiceGraphResponse> {
  return proxyApi
    .get("mesh/service-graph", scoped(scope))
    .json<MeshServiceGraphResponse>();
}

/* ---------- Egress scope ---------- */

export interface MeshEgressScopeResource {
  namespace: string;
  name: string;
  hosts?: string[];
  ports?: number[];
}

export interface MeshEgressScopeResponse {
  namespace: string;
  scope: {
    sidecar_enforced: boolean;
    dry_run: boolean;
    sidecar_applied: boolean;
    sidecar_admitted_services: number;
    sidecar_denied_services: number;
    sidecar_admitted_destination_rules: number;
    sidecar_denied_destination_rules: number;
    destination_rules?: MeshEgressScopeResource[];
    services?: MeshEgressScopeResource[];
    service_entries?: MeshEgressScopeResource[];
    known_destinations?: string[];
  };
  health: {
    sidecar_admitted_services: number;
    sidecar_denied_services: number;
  };
}

export async function getEgressScope(
  scope: NamespaceScope,
): Promise<MeshEgressScopeResponse> {
  return proxyApi
    .get("mesh/egress-scope", scoped(scope))
    .json<MeshEgressScopeResponse>();
}

export interface EgressScopeTestResult {
  allowed: boolean;
  decision: "admit" | "deny";
  host: string;
  port: number | null;
  dry_run: boolean;
}

export async function testEgressScope(
  scope: NamespaceScope,
  host: string,
  port?: number,
): Promise<EgressScopeTestResult> {
  return proxyApi
    .post(
      "mesh/egress-scope/test",
      scoped(scope, { json: port !== undefined ? { host, port } : { host } }),
    )
    .json<EgressScopeTestResult>();
}

/* ---------- Federation & remote clusters ---------- */

export interface MeshFederationBundle {
  cluster: string;
  trust_domain: string;
  endpoint: string;
  fetched_at_unix_seconds: number;
  bundle_age_seconds: number;
  x509_authorities: number;
  jwt_authorities: number;
  refresh_hint_seconds?: number | null;
}

export async function getFederation(
  scope: NamespaceScope,
): Promise<{ bundles: MeshFederationBundle[] }> {
  return proxyApi
    .get("mesh/federation", scoped(scope))
    .json<{ bundles: MeshFederationBundle[] }>();
}

export interface DiscoveredCluster {
  cluster_name: string;
  trust_domain: string;
  network?: string | null;
  workload_count: number;
  service_count: number;
  fetched_at_unix_seconds: number;
  age_seconds: number;
}

export interface ConfiguredCluster {
  cluster_name: string;
  trust_domain: string;
  network?: string | null;
  control_plane_configured: boolean;
  federation_endpoint_configured: boolean;
  discovery_audience?: string | null;
  discovered: boolean;
  outbound_trust_active: boolean;
  inbound_trust_active: boolean;
  trust_source: "polled" | "control_plane" | "local" | "blocked_pending_poll" | "none";
  trust_bundle_age_seconds?: number | null;
}

export interface MeshRemoteClustersResponse {
  discovery_enabled: boolean;
  discovered: DiscoveredCluster[];
  configured: ConfiguredCluster[];
}

export async function getRemoteClusters(
  scope: NamespaceScope,
): Promise<MeshRemoteClustersResponse> {
  return proxyApi
    .get("mesh/remote-clusters", scoped(scope))
    .json<MeshRemoteClustersResponse>();
}

/* ---------- Config drift ---------- */

export interface MeshConfigDriftResponse {
  slice: {
    last_received_at?: string;
    age_seconds?: number;
    version?: string;
    namespace?: string;
    resources: Record<string, number>;
    fingerprint?: string;
    source_protocol: "native" | "xds";
    source_cp_url: string;
  };
  runtime_overlay?: {
    key_count: number;
    keys: string[];
    fingerprint: string;
  };
  convergence?: {
    per_type_versions: Record<string, string>;
    missing_required_types: string[];
    converged: boolean;
    version_skew: boolean;
  };
  revision: {
    accepted?: { authority: string; sequence: number };
    applied?: { authority: string; sequence: number };
    quarantined?: {
      authority: string;
      sequence: number;
      reason: string;
      consecutive: number;
      first_seen_at: string;
      last_seen_at: string;
    };
    rejected_total: number;
    adopted_total: number;
    quarantine_active: boolean;
  };
}

export async function getConfigDrift(
  scope: NamespaceScope,
): Promise<MeshConfigDriftResponse> {
  return proxyApi
    .get("mesh/config-drift", scoped(scope))
    .json<MeshConfigDriftResponse>();
}

export async function resetConfigRevision(scope: NamespaceScope): Promise<{
  status: string;
  cleared_revision?: { authority: string; sequence: number } | null;
}> {
  return proxyApi
    .post("mesh/config-revision/reset", scoped(scope))
    .json<{ status: string; cleared_revision?: { authority: string; sequence: number } | null }>();
}

/* ---------- Slice drift (CP) ---------- */

export interface MeshSliceVersionStamp {
  version: string;
  at: string;
  age_seconds: number;
}

export type MeshSliceConvergence =
  | "converged"
  | "drifted"
  | "rejecting"
  | "pending"
  | "disconnected";

export interface MeshSliceDriftEntry {
  node_id: string;
  namespace: string;
  connected: boolean;
  session_connected_at: string;
  disconnected_at?: string;
  desired?: MeshSliceVersionStamp;
  sent?: MeshSliceVersionStamp;
  acknowledged?: MeshSliceVersionStamp;
  rejected?: MeshSliceVersionStamp & { reason: string };
  convergence: MeshSliceConvergence;
  drift: {
    desired_vs_sent: boolean;
    desired_vs_acknowledged: boolean;
    sent_vs_acknowledged: boolean;
  };
}

export interface MeshSliceDriftResponse {
  mode: "cp";
  generated_at: string;
  summary: {
    tracked: number;
    connected: number;
    converged: number;
    drifted: number;
    rejecting: number;
    pending: number;
    disconnected: number;
  };
  data_planes: MeshSliceDriftEntry[];
}

export async function getSliceDrift(
  scope: NamespaceScope,
): Promise<MeshSliceDriftResponse> {
  return proxyApi
    .get("mesh/slice-drift", scoped(scope))
    .json<MeshSliceDriftResponse>();
}

/* ---------- Policy denies ---------- */

export interface MeshPolicyDenyGroup {
  rule: string;
  source?: string;
  destination?: string;
  reason: string;
  count: number;
  first_at: string;
  last_at: string;
}

export interface MeshPolicyDeniesResponse {
  window_seconds: number;
  limit: number;
  total_denies: number;
  grouped: MeshPolicyDenyGroup[];
}

export async function getPolicyDenies(
  scope: NamespaceScope,
  window = "5m",
  limit = 50,
): Promise<MeshPolicyDeniesResponse> {
  return proxyApi
    .get(
      "mesh/policy-denies/recent",
      scoped(scope, { searchParams: { window, limit: String(limit) } }),
    )
    .json<MeshPolicyDeniesResponse>();
}

/* ---------- Waypoints ---------- */

export interface NodeWaypointIdentityEntry {
  pod_uid: string;
  spiffe_id: string;
  workload_spiffe_hash: number;
  orig_dst4_cookies: number;
  orig_dst6_cookies: number;
  has_policy_scope: boolean;
}

export interface NodeWaypointIdentitiesResponse {
  identity_count: number;
  cookies: { orig_dst4: number; orig_dst6: number };
  identities: NodeWaypointIdentityEntry[];
}

export async function getNodeWaypointIdentities(
  scope: NamespaceScope,
): Promise<NodeWaypointIdentitiesResponse> {
  return proxyApi
    .get("node-waypoint/identities", scoped(scope))
    .json<NodeWaypointIdentitiesResponse>();
}

export interface ServiceWaypointServiceEntry {
  namespace: string;
  name: string;
  ports: number[];
  workload_count: number;
}

export interface ServiceWaypointServicesResponse {
  waypoint_name: string;
  namespace: string;
  service_count: number;
  services: ServiceWaypointServiceEntry[];
}

export async function getServiceWaypointServices(
  scope: NamespaceScope,
): Promise<ServiceWaypointServicesResponse> {
  return proxyApi
    .get("service-waypoint/services", scoped(scope))
    .json<ServiceWaypointServicesResponse>();
}
