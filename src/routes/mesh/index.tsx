/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Mesh observability page                           */
/*  Read-only views over the mesh admin endpoints. Every endpoint      */
/*  404s outside mesh mode, which renders as a friendly empty state.  */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useServiceGraph,
  useConfigDrift,
  useSliceDrift,
  usePolicyDenies,
  useRemoteClusters,
  useFederation,
  useEgressScope,
  useTestEgressScope,
  useNodeWaypointIdentities,
  useServiceWaypointServices,
} from "@/hooks/useMesh";
import { GatewayTrustManager } from "@/components/forms/GatewayTrustManager";

function NotMeshEmpty({ what }: { what: string }) {
  return (
    <EmptyState
      title={`${what} unavailable`}
      description="This endpoint is only served in mesh mode (or the data has not been established yet)."
    />
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" | "bad" }) {
  const color =
    tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning" : "text-text-primary";
  return (
    <div className="bg-bg-card border border-border rounded-lg px-4 py-3">
      <p className="text-xs text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

/* ---------- Overview: config drift + slice drift ---------- */

function OverviewTab() {
  const configQuery = useConfigDrift();
  const sliceQuery = useSliceDrift();
  const { data: drift, isLoading, isError } = configQuery;
  const { data: sliceDrift, isError: sliceError } = sliceQuery;

  return (
    <div className="space-y-4">
      {isLoading && <SkeletonCard />}
      {isError && (drift ? (
        <Card className="border-warning/40">
          <p className="text-sm text-warning">Mesh configuration refresh failed</p>
          <p className="text-xs text-text-muted mt-1">
            Current convergence and quarantine state are unavailable. Last successful observation:{" "}
            {new Date(configQuery.dataUpdatedAt).toLocaleString()}.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" loading={configQuery.isFetching}
            onClick={() => void configQuery.refetch()}>Retry configuration</Button>
        </Card>
      ) : <NotMeshEmpty what="Mesh configuration state" />)}
      {drift && !isError && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Source" value={drift.slice.source_protocol} />
            <StatTile
              label="Slice age"
              value={drift.slice.age_seconds != null ? `${drift.slice.age_seconds}s` : "—"}
              tone={drift.slice.age_seconds != null && drift.slice.age_seconds > 300 ? "warn" : "good"}
            />
            <StatTile
              label="Quarantine"
              value={drift.revision.quarantine_active ? "ACTIVE" : "clear"}
              tone={drift.revision.quarantine_active ? "bad" : "good"}
            />
            <StatTile label="Rejected total" value={drift.revision.rejected_total} tone={drift.revision.rejected_total > 0 ? "warn" : "good"} />
          </div>

          <Card>
            <h3 className="text-sm font-semibold text-text-primary mb-3">Slice Resources</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-2">
              {Object.entries(drift.slice.resources).map(([key, count]) => (
                <div key={key} className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">{key.replace(/_/g, " ")}</span>
                  <span className="text-text-primary font-medium">{count}</span>
                </div>
              ))}
            </div>
            {drift.slice.version && (
              <p className="text-xs text-text-muted mt-3 font-mono">
                version {drift.slice.version}
                {drift.slice.fingerprint ? ` · ${drift.slice.fingerprint.slice(0, 24)}…` : ""}
              </p>
            )}
          </Card>

          {drift.revision.quarantined && (
            <Card className="border-danger/40">
              <h3 className="text-sm font-semibold text-danger mb-2">Quarantined Revision</h3>
              <p className="text-sm text-text-secondary">
                {drift.revision.quarantined.authority} seq {drift.revision.quarantined.sequence} —{" "}
                {drift.revision.quarantined.reason.replace(/_/g, " ")} (
                {drift.revision.quarantined.consecutive} consecutive)
              </p>
            </Card>
          )}

          {drift.convergence && (
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-sm font-semibold text-text-primary">xDS Convergence</h3>
                <Badge variant={drift.convergence.converged ? "green" : "yellow"}>
                  {drift.convergence.converged ? "converged" : "converging"}
                </Badge>
                {drift.convergence.version_skew && <Badge variant="yellow">version skew</Badge>}
              </div>
              {drift.convergence.missing_required_types.length > 0 && (
                <p className="text-xs text-danger">
                  Missing: {drift.convergence.missing_required_types.join(", ")}
                </p>
              )}
            </Card>
          )}
        </>
      )}

      {/* CP-side slice drift is an independent observation. */}
      {sliceQuery.isLoading && <SkeletonCard />}
      {sliceError && (sliceDrift ? (
        <Card className="border-warning/40">
          <p className="text-sm text-warning">Data plane convergence refresh failed</p>
          <p className="text-xs text-text-muted mt-1">
            Current data plane convergence is unavailable. Last successful observation:{" "}
            {new Date(sliceQuery.dataUpdatedAt).toLocaleString()}.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" loading={sliceQuery.isFetching}
            onClick={() => void sliceQuery.refetch()}>Retry convergence</Button>
        </Card>
      ) : <NotMeshEmpty what="Data plane convergence" />)}
      {sliceDrift && !sliceError && (
        <Card className="overflow-hidden p-0">
          <div className="px-6 py-3 border-b border-border flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              Data Plane Convergence (CP view)
            </h3>
            <span className="text-xs text-text-muted">
              {sliceDrift.summary.converged}/{sliceDrift.summary.tracked} converged
            </span>
          </div>
          {sliceDrift.data_planes.map((dp) => (
            <div key={dp.node_id} className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-text-primary font-medium">{dp.node_id}</p>
                <p className="text-xs text-text-muted">
                  ns {dp.namespace}
                  {dp.acknowledged ? ` · acked ${dp.acknowledged.version} (${dp.acknowledged.age_seconds}s ago)` : ""}
                </p>
                {dp.rejected && (
                  <p className="text-xs text-danger">rejected {dp.rejected.version}</p>
                )}
              </div>
              <Badge
                variant={
                  dp.convergence === "converged"
                    ? "green"
                    : dp.convergence === "disconnected"
                      ? "default"
                      : dp.convergence === "rejecting"
                        ? "red"
                        : "yellow"
                }
              >
                {dp.convergence}
              </Badge>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ---------- Service graph ---------- */

function ServiceGraphTab() {
  const { data, isLoading, isError } = useServiceGraph();

  if (isLoading) return <SkeletonCard />;
  if (isError || !data) return <NotMeshEmpty what="Service graph" />;

  return (
    <Card className="overflow-hidden p-0">
      <div className="px-6 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">
          {data.edge_count} edge(s)
        </h3>
        <span className="text-xs text-text-muted">
          generated {new Date(data.generated_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="grid grid-cols-[2fr_2fr_5rem_5rem_5rem_6rem] gap-3 px-6 py-3 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
        <span>Source</span>
        <span>Destination</span>
        <span>Requests</span>
        <span>Errors</span>
        <span>Avg ms</span>
        <span>Security</span>
      </div>
      {data.edges.length === 0 && (
        <EmptyState title="No traffic observed" description="Edges appear as mesh traffic flows." />
      )}
      {data.edges.map((edge, i) => (
        <div
          key={i}
          className="grid grid-cols-[2fr_2fr_5rem_5rem_5rem_6rem] gap-3 px-6 py-3 border-b border-border/50 last:border-b-0 items-center"
        >
          <div className="min-w-0">
            <p className="text-sm text-text-primary truncate">
              {edge.source_workload || edge.source_app || "unknown"}
            </p>
            <p className="text-xs text-text-muted truncate">{edge.source_namespace}</p>
          </div>
          <div className="min-w-0">
            <p className="text-sm text-text-primary truncate">
              {edge.destination_service || edge.destination_workload || "unknown"}
            </p>
            <p className="text-xs text-text-muted truncate">{edge.destination_namespace}</p>
          </div>
          <span className="text-sm text-text-primary">{edge.requests_total}</span>
          <span className={`text-sm ${edge.errors_total > 0 ? "text-danger" : "text-text-muted"}`}>
            {edge.errors_total}
          </span>
          <span className="text-sm text-text-secondary">
            {edge.duration_ms_avg.toFixed(1)}
          </span>
          <Badge variant={edge.connection_security_policy === "mutual_tls" ? "green" : "yellow"}>
            {edge.connection_security_policy || "unknown"}
          </Badge>
        </div>
      ))}
    </Card>
  );
}

/* ---------- Policy denies ---------- */

function PolicyDeniesTab() {
  const { data, isLoading, isError } = usePolicyDenies("15m", 100);

  if (isLoading) return <SkeletonCard />;
  if (isError || !data) return <NotMeshEmpty what="Policy denies" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatTile
          label={`Denies (${Math.round(data.window_seconds / 60)}m)`}
          value={data.total_denies}
          tone={data.total_denies > 0 ? "warn" : "good"}
        />
      </div>
      <Card className="overflow-hidden p-0">
        {data.grouped.length === 0 && (
          <EmptyState title="No recent denies" description="mesh_authz denials will be aggregated here." />
        )}
        {data.grouped.map((group, i) => (
          <div key={i} className="px-6 py-3 border-b border-border/50 last:border-b-0">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="red">{group.count}×</Badge>
              <span className="text-sm text-text-primary font-medium">{group.rule}</span>
              <span className="text-xs text-text-muted">{group.reason}</span>
              <span className="text-xs text-text-muted ml-auto">
                last {new Date(group.last_at).toLocaleTimeString()}
              </span>
            </div>
            {(group.source || group.destination) && (
              <p className="text-xs text-text-muted mt-1 font-mono truncate">
                {group.source ?? "?"} → {group.destination ?? "?"}
              </p>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ---------- Clusters & federation ---------- */

function ClustersTab() {
  const { data: remote, isError: remoteErr } = useRemoteClusters();
  const { data: federation } = useFederation();

  if (remoteErr && !federation) return <NotMeshEmpty what="Multicluster state" />;

  return (
    <div className="space-y-6">
      {remote && (
        <>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Remote Clusters</h3>
            <Badge variant={remote.discovery_enabled ? "green" : "default"}>
              discovery {remote.discovery_enabled ? "on" : "off"}
            </Badge>
          </div>
          <Card className="overflow-hidden p-0">
            {remote.configured.length === 0 && remote.discovered.length === 0 && (
              <EmptyState title="No remote clusters" description="Configured and discovered clusters appear here." />
            )}
            {remote.configured.map((cluster) => (
              <div key={cluster.cluster_name} className="px-6 py-3.5 border-b border-border/50 last:border-b-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">{cluster.cluster_name}</span>
                  <Badge variant={cluster.discovered ? "green" : "yellow"}>
                    {cluster.discovered ? "discovered" : "not discovered"}
                  </Badge>
                  <Badge variant={cluster.outbound_trust_active ? "green" : "red"}>
                    outbound trust {cluster.outbound_trust_active ? "active" : "inactive"}
                  </Badge>
                  <Badge variant={cluster.inbound_trust_active ? "green" : "red"}>
                    inbound trust {cluster.inbound_trust_active ? "active" : "inactive"}
                  </Badge>
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {cluster.trust_domain} · trust via {cluster.trust_source.replace(/_/g, " ")}
                  {cluster.network ? ` · network ${cluster.network}` : ""}
                </p>
              </div>
            ))}
            {remote.discovered
              .filter((d) => !remote.configured.some((c) => c.cluster_name === d.cluster_name))
              .map((cluster) => (
                <div key={cluster.cluster_name} className="px-6 py-3.5 border-b border-border/50 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{cluster.cluster_name}</span>
                    <Badge variant="blue">discovered only</Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    {cluster.trust_domain} · {cluster.workload_count} workloads ·{" "}
                    {cluster.service_count} services · fetched {cluster.age_seconds}s ago
                  </p>
                </div>
              ))}
          </Card>
        </>
      )}

      {federation && federation.bundles.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-text-primary">Federated Trust Bundles</h3>
          <Card className="overflow-hidden p-0">
            {federation.bundles.map((bundle) => (
              <div key={bundle.cluster} className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary font-medium">{bundle.cluster}</p>
                  <p className="text-xs text-text-muted truncate">
                    {bundle.trust_domain} · {bundle.endpoint}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="blue">{bundle.x509_authorities} x509</Badge>
                  <Badge variant="purple">{bundle.jwt_authorities} jwt</Badge>
                  <span className="text-xs text-text-muted">{bundle.bundle_age_seconds}s old</span>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

/* ---------- Egress scope ---------- */

function EgressTab() {
  const { toast } = useToast();
  const { data, isLoading, isError } = useEgressScope();
  const testEgress = useTestEgressScope();
  const [testHost, setTestHost] = useState("");
  const [testPort, setTestPort] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  if (isLoading) return <SkeletonCard />;
  if (isError || !data) return <NotMeshEmpty what="Egress scope" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="Enforcement"
          value={data.scope.sidecar_enforced ? (data.scope.dry_run ? "dry-run" : "enforced") : "off"}
          tone={data.scope.sidecar_enforced && !data.scope.dry_run ? "good" : "warn"}
        />
        <StatTile label="Admitted services" value={data.scope.sidecar_admitted_services} />
        <StatTile
          label="Denied services"
          value={data.scope.sidecar_denied_services}
          tone={data.scope.sidecar_denied_services > 0 ? "warn" : "good"}
        />
        <StatTile label="Known destinations" value={data.scope.known_destinations?.length ?? 0} />
      </div>

      {/* Dry-run tester */}
      <Card>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Test a Destination</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Input label="Host" value={testHost} onChange={(e) => setTestHost(e.target.value)} placeholder="api.external.com" />
          </div>
          <div className="w-28">
            <Input label="Port" type="number" value={testPort} onChange={(e) => setTestPort(e.target.value)} placeholder="443" />
          </div>
          <Button
            size="sm"
            loading={testEgress.isPending}
            onClick={async () => {
              setTestResult(null);
              try {
                const res = await testEgress.mutateAsync({
                  host: testHost,
                  ...(testPort && { port: Number(testPort) }),
                });
                setTestResult(
                  `${res.decision.toUpperCase()} — ${res.host}${res.port ? `:${res.port}` : ""}${res.dry_run ? " (dry-run mode)" : ""}`,
                );
              } catch (err) {
                toast("error", await getApiErrorMessage(err, "Test failed"));
              }
            }}
          >
            Test
          </Button>
          {testResult && (
            <Badge variant={testResult.startsWith("ADMIT") ? "green" : "red"}>{testResult}</Badge>
          )}
        </div>
      </Card>

      {(data.scope.known_destinations ?? []).length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-text-primary mb-3">Known Destinations</h3>
          <div className="flex flex-wrap gap-1.5">
            {(data.scope.known_destinations ?? []).map((dest) => (
              <Badge key={dest} variant="default">{dest}</Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------- Waypoints ---------- */

function WaypointsTab() {
  const { data: nodeIdentities, isError: nodeErr } = useNodeWaypointIdentities();
  const { data: services, isError: svcErr } = useServiceWaypointServices();

  if (nodeErr && svcErr) return <NotMeshEmpty what="Waypoint topology" />;

  return (
    <div className="space-y-6">
      {nodeIdentities && (
        <>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Node Waypoint Identities</h3>
            <Badge variant="blue">{nodeIdentities.identity_count}</Badge>
          </div>
          <Card className="overflow-hidden p-0">
            {nodeIdentities.identities.map((identity) => (
              <div key={identity.pod_uid} className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-text-primary truncate">{identity.spiffe_id}</p>
                  <p className="text-xs text-text-muted">pod {identity.pod_uid}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="default">
                    {identity.orig_dst4_cookies + identity.orig_dst6_cookies} cookies
                  </Badge>
                  {identity.has_policy_scope && <Badge variant="green">policy scope</Badge>}
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      {services && (
        <>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              Service Waypoint · {services.waypoint_name}
            </h3>
            <Badge variant="blue">{services.service_count} services</Badge>
          </div>
          <Card className="overflow-hidden p-0">
            {services.services.map((service) => (
              <div key={`${service.namespace}/${service.name}`} className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
                <span className="text-sm text-text-primary">
                  {service.namespace}/{service.name}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">
                    ports {service.ports.join(", ")}
                  </span>
                  <Badge variant="default">{service.workload_count} workloads</Badge>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

/* ---------- Gateway trust ---------- */

function TrustTab() {
  return <GatewayTrustManager />;
}

/* ================================================================== */
/*  MeshPage                                                           */
/* ================================================================== */

export default function MeshPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Mesh</h1>
        <p className="text-text-muted text-sm mt-1">
          Service graph, config convergence, multicluster trust, egress scope,
          and waypoint topology for mesh-mode gateways.
        </p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="graph">Service Graph</TabsTrigger>
          <TabsTrigger value="denies">Policy Denies</TabsTrigger>
          <TabsTrigger value="clusters">Clusters</TabsTrigger>
          <TabsTrigger value="egress">Egress</TabsTrigger>
          <TabsTrigger value="waypoints">Waypoints</TabsTrigger>
          <TabsTrigger value="trust">Trust</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="graph"><ServiceGraphTab /></TabsContent>
        <TabsContent value="denies"><PolicyDeniesTab /></TabsContent>
        <TabsContent value="clusters"><ClustersTab /></TabsContent>
        <TabsContent value="egress"><EgressTab /></TabsContent>
        <TabsContent value="waypoints"><WaypointsTab /></TabsContent>
        <TabsContent value="trust"><TrustTab /></TabsContent>
      </Tabs>
    </div>
  );
}
