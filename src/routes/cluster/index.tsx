/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Cluster & backend capabilities page               */
/* ------------------------------------------------------------------ */

import { Card } from "@/components/ui/Card";
import { GRID_HEADER_CLASS, GRID_ROW_CLASS, ResourceGrid } from "@/components/ui/ResourceGrid";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import { useCapabilities } from "@/stores/capabilities";
import { WriteAction } from "@/components/shared/CapabilityGate";
import type { CapabilityVerdict } from "@/lib/capabilities";
import {
  useClusterStatus,
  useBackendCapabilities,
  useRefreshBackendCapabilities,
} from "@/hooks/useOps";
import {
  backendProbesSupported,
  isCpStatus,
  isDpStatus,
  type BackendCapabilitiesResponse,
  type ConnectedDpNode,
  type DataPlaneEgressSummary,
  type ProtocolSupport,
} from "@/api/ops";
import { formatDateTime, formatTime } from "@/lib/format";

function supportBadge(support: ProtocolSupport, stale = false) {
  if (stale) return <Badge variant="default">{support === "supported" ? "yes" : support === "unsupported" ? "no" : "?"}</Badge>;
  if (support === "supported") return <Badge variant="green">yes</Badge>;
  if (support === "unsupported") return <Badge variant="red">no</Badge>;
  return <Badge variant="default">?</Badge>;
}

/** A data plane's self-reported egress policy; `null` where none is carried. */
function egressPolicyLabel(node: ConnectedDpNode): string | null {
  const attestation = node.backend_egress_policy_attestation;
  if (attestation === undefined) return null;
  const policy = node.backend_egress_policy;
  if (attestation !== "reported" || !policy) return "egress policy unknown";
  return `egress ${policy.mode}${policy.public_only_guaranteed ? " · public-only" : ""}`;
}

function EgressAttestationSummary({
  summary,
  stale,
}: {
  summary: DataPlaneEgressSummary;
  stale: boolean;
}) {
  const weakest = summary.weakest_policy;
  return (
    <div className="mt-3 space-y-1 text-sm text-text-secondary">
      <p>
        Backend egress{stale ? " in last known snapshot" : ""}:{" "}
        {summary.reporting_data_planes} of {summary.connected_data_planes} data plane(s) reported ·{" "}
        {summary.unknown_data_planes} unknown · weakest reported mode{" "}
        {weakest ? weakest.mode : "none"}
        {summary.weakest_policy_complete ? "" : " (incomplete)"} · public-only for every
        connected data plane: {summary.all_connected_public_only_guaranteed ? "yes" : "no"}
      </p>
      <p className="text-xs text-text-muted">
        Covers connected data planes in every namespace. Self-reported over ConfigSync,
        not host attestation. A disconnected data plane still serving cached configuration
        is not listed.
      </p>
    </div>
  );
}

function unsupportedProbeMessage(connectedDataPlanes: number): string {
  const intro =
    "Backend protocol probes belong to a data plane, not this control plane. This process does not run proxy probe state.";
  if (connectedDataPlanes <= 0) {
    return `${intro} Connect Foundry to a data plane to view and refresh probe results.`;
  }
  if (connectedDataPlanes === 1) {
    return `${intro} The connected data plane exposes probe results on its own admin API.`;
  }
  return `${intro} The ${connectedDataPlanes} connected data planes expose probe results on their own admin APIs.`;
}

type BackendCapabilitiesPanelProps =
  | { surface: "pending" }
  | { surface: "unsupported"; connectedDataPlanes: number }
  | {
      surface: "probe";
      capabilities: BackendCapabilitiesResponse | undefined;
      isError: boolean;
      isLoading: boolean;
      isFetching: boolean;
      dataUpdatedAt: number;
      reprobePending: boolean;
      /**
       * `POST /backend-capabilities/refresh` is an operator action, so a viewer
       * session sees the reason instead of a 403 dialog.
       */
      reprobeCapability: CapabilityVerdict;
      onRetry: () => void;
      onReprobe: () => void | Promise<void>;
    };

function BackendCapabilitiesPanel(props: BackendCapabilitiesPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-primary">
            Backend Capabilities
          </h2>
          <p className="text-text-muted text-sm">
            Probed protocol support per backend (HTTP/1.1, H2, H3, gRPC, HBONE).
          </p>
        </div>
        {props.surface === "probe" ? (
          <WriteAction verdict={props.reprobeCapability}>
            <Button
              variant="secondary"
              loading={props.reprobePending}
              onClick={() => { void props.onReprobe(); }}
            >
              Re-probe All
            </Button>
          </WriteAction>
        ) : null}
      </div>

      {props.surface === "pending" ? (
        <div className="text-text-muted text-sm">Loading…</div>
      ) : null}

      {props.surface === "unsupported" ? (
        <Card>
          <p className="text-sm text-text-secondary">
            {unsupportedProbeMessage(props.connectedDataPlanes)}
          </p>
        </Card>
      ) : null}

      {props.surface === "probe" ? <ProbeResults {...props} /> : null}
    </div>
  );
}

function ProbeResults({
  capabilities,
  isError,
  isLoading,
  isFetching,
  dataUpdatedAt,
  onRetry,
}: Extract<BackendCapabilitiesPanelProps, { surface: "probe" }>) {
  return (
    <>
      {isError ? (
        <div role="alert" className="rounded-lg border border-danger/50 p-4 text-sm">
          <p>{capabilities ? "Capabilities refresh failed. Showing last known probe results; current support is unavailable." : "Backend capabilities unavailable. The request failed."}</p>
          <Button variant="secondary" size="sm" loading={isFetching} onClick={onRetry}>
            Retry capabilities
          </Button>
        </div>
      ) : null}
      {capabilities ? (
        <p className="text-xs text-text-muted">
          {isError ? "Last known capabilities" : "Capabilities"} observed: {formatDateTime(dataUpdatedAt)}
        </p>
      ) : null}
      <ResourceGrid
        label="Backend capabilities"
        minWidth="48rem"
        emptyState={
          !isLoading && !isError && capabilities?.entries.length === 0 ? (
            <EmptyState
              title="No backend probes yet"
              description="Capabilities are collected as proxies dispatch to backends, or on demand via Re-probe All."
            />
          ) : null
        }
      >
        <div className={`grid grid-cols-[2fr_4rem_4rem_4rem_6rem_5rem_4rem_5rem] gap-3 ${GRID_HEADER_CLASS}`}>
          <span>Backend</span>
          <span>H1</span>
          <span>H2/TLS</span>
          <span>H3</span>
          <span>gRPC H2/TLS</span>
          <span>gRPC h2c</span>
          <span>HBONE</span>
          <span>Probed</span>
        </div>
        {isLoading ? <div className="px-4 py-8 text-text-muted text-sm">Loading…</div> : null}
        {(capabilities?.entries ?? []).map((entry) => (
          <div
            key={entry.key}
            className={`grid grid-cols-[2fr_4rem_4rem_4rem_6rem_5rem_4rem_5rem] gap-3 ${GRID_ROW_CLASS} border-b border-border/50 last:border-b-0`}
          >
            <div className="min-w-0">
              <p className="text-xs font-mono text-text-primary truncate">
                {entry.key.split("|").slice(0, 3).join(" · ")}
              </p>
              {entry.last_probe_error ? (
                <p className="text-xs text-danger truncate">{entry.last_probe_error}</p>
              ) : null}
            </div>
            <span>{supportBadge(entry.plain_http.h1, isError)}</span>
            <span>{supportBadge(entry.plain_http.h2_tls, isError)}</span>
            <span>{supportBadge(entry.plain_http.h3, isError)}</span>
            <span>{supportBadge(entry.grpc_transport.h2_tls, isError)}</span>
            <span>{supportBadge(entry.grpc_transport.h2c, isError)}</span>
            <span>{supportBadge(entry.hbone, isError)}</span>
            <span className="text-xs text-text-muted">
              {entry.last_probe_at_unix_secs
                ? formatTime(entry.last_probe_at_unix_secs * 1000)
                : "—"}
            </span>
          </div>
        ))}
      </ResourceGrid>
    </>
  );
}

export default function ClusterPage() {
  const { toast } = useToast();
  const clusterQuery = useClusterStatus();
  const { data: cluster, isLoading: clusterLoading, isError: clusterError } = clusterQuery;
  const probeQueryEnabled = cluster != null ? backendProbesSupported(cluster) : clusterError;
  const capsQuery = useBackendCapabilities(probeQueryEnabled);
  const { data: capabilities, isLoading: capsLoading, isError: capsError } = capsQuery;
  const refresh = useRefreshBackendCapabilities();
  // `capabilities` is already the probe response above, so this one is named
  // for what it gates.
  const reprobeCapability = useCapabilities().capabilities.operationalActions;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cluster"
        description="Control-plane / data-plane topology and probed backend protocol capabilities."
      />

      {/* Cluster status */}
      {clusterLoading && <SkeletonCard />}
      {clusterError && (
        <div role="alert" className="rounded-lg border border-danger/50 p-4 text-sm">
          <p>{cluster ? "Topology refresh failed. Showing last known topology; current node status is unavailable." : "Cluster topology unavailable. The request failed."}</p>
          <Button variant="secondary" size="sm" loading={clusterQuery.isFetching} onClick={() => void clusterQuery.refetch()}>
            Retry topology
          </Button>
        </div>
      )}
      {cluster && (
        <p className="text-xs text-text-muted">
          Topology observed: {formatDateTime(clusterQuery.dataUpdatedAt)}
        </p>
      )}
      {cluster && isCpStatus(cluster) && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-4">
              <Badge variant="blue" className="px-3 py-1">CONTROL PLANE</Badge>
              <span className="text-sm text-text-secondary">
                {cluster.connected_data_planes} data plane(s) ·{" "}
                {cluster.connected_mesh_nodes} mesh node(s) connected{clusterError ? " in last known snapshot" : ""}
              </span>
            </div>
            {cluster.data_plane_backend_egress_policy ? (
              <EgressAttestationSummary
                summary={cluster.data_plane_backend_egress_policy}
                stale={clusterError}
              />
            ) : null}
          </Card>
          {[
            { title: "Data Planes", nodes: cluster.data_planes },
            { title: "Mesh Nodes", nodes: cluster.mesh_nodes },
          ].map(({ title, nodes }) => (
            <Card key={title} padding="none" className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
              </div>
              {nodes.length === 0 && (
                <EmptyState title={`No ${title.toLowerCase()} connected${clusterError ? " in last known snapshot" : ""}`} description="" />
              )}
              {nodes.map((node, index) => {
                const egress = egressPolicyLabel(node);
                return (
                  // Edge v0.9.14 lists one entry per Subscribe stream, so
                  // several can share a node_id.
                  <div
                    key={`${node.node_id}:${node.connected_at}:${index}`}
                    className="px-4 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary font-medium">{node.node_id}</p>
                      <p className="text-xs text-text-muted">
                        v{node.version} · ns {node.namespace} · connected{" "}
                        {formatDateTime(node.connected_at)} · last sync {formatDateTime(node.last_sync_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {egress ? <Badge variant="default">{egress}</Badge> : null}
                      <Badge variant={clusterError ? "default" : "green"}>{clusterError ? "last known online" : "online"}</Badge>
                    </div>
                  </div>
                );
              })}
            </Card>
          ))}
        </div>
      )}
      {cluster && isDpStatus(cluster) && (
        <Card>
          <div className="flex items-center gap-4 mb-3">
            <Badge variant="purple" className="px-3 py-1">DATA PLANE</Badge>
            <Badge variant={clusterError ? "default" : cluster.control_plane.status === "online" ? "green" : "red"}>
              {clusterError ? "Last known CP" : "CP"} {cluster.control_plane.status}
            </Badge>
            {cluster.control_plane.config_diverged && (
              <Badge variant={clusterError ? "default" : "red"}>{clusterError ? "last known config diverged" : "config diverged"}</Badge>
            )}
          </div>
          <div className="space-y-1 text-sm text-text-secondary">
            <p>
              Control plane:{" "}
              <span className="font-mono text-text-primary">{cluster.control_plane.url}</span>
              {cluster.control_plane.is_primary ? " (primary)" : ""}
            </p>
            <p>Connected since: {formatDateTime(cluster.control_plane.connected_since)}</p>
            <p>Last config received: {formatDateTime(cluster.control_plane.last_config_received_at)}</p>
            <p>
              Divergence recoveries:{" "}
              {cluster.control_plane.config_divergence_recoveries_total}
            </p>
          </div>
        </Card>
      )}
      {cluster && !isCpStatus(cluster) && !isDpStatus(cluster) && (
        <Card>
          <div className="flex items-center gap-3">
            <Badge variant="default" className="px-3 py-1">
              {cluster.mode.toUpperCase()} MODE
            </Badge>
            <span className="text-sm text-text-muted">
              {"message" in cluster ? cluster.message : "Standalone gateway — no cluster topology."}
            </span>
          </div>
        </Card>
      )}

      {cluster && isCpStatus(cluster) ? (
        <BackendCapabilitiesPanel
          surface="unsupported"
          connectedDataPlanes={cluster.connected_data_planes}
        />
      ) : !cluster && !clusterError ? (
        <BackendCapabilitiesPanel surface="pending" />
      ) : (
        <BackendCapabilitiesPanel
          surface="probe"
          capabilities={capabilities}
          isError={capsError}
          isLoading={capsLoading}
          isFetching={capsQuery.isFetching}
          dataUpdatedAt={capsQuery.dataUpdatedAt}
          reprobePending={refresh.isPending}
          reprobeCapability={reprobeCapability}
          onRetry={() => { void capsQuery.refetch(); }}
          onReprobe={async () => {
            if (!reprobeCapability.allowed) return;
            try {
              await refresh.mutateAsync();
              toast("success", "Backend probes refreshed");
            } catch (err) {
              toast("error", await getApiErrorMessage(err, "Refresh failed"));
            }
          }}
        />
      )}
    </div>
  );
}
