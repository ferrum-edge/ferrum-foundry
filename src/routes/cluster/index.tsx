/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Cluster & backend capabilities page               */
/* ------------------------------------------------------------------ */

import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useClusterStatus,
  useBackendCapabilities,
  useRefreshBackendCapabilities,
} from "@/hooks/useOps";
import { isCpStatus, isDpStatus } from "@/api/ops";
import type { ProtocolSupport } from "@/api/ops";

function supportBadge(support: ProtocolSupport) {
  if (support === "supported") return <Badge variant="green">yes</Badge>;
  if (support === "unsupported") return <Badge variant="red">no</Badge>;
  return <Badge variant="default">?</Badge>;
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function ClusterPage() {
  const { toast } = useToast();
  const { data: cluster, isLoading: clusterLoading } = useClusterStatus();
  const { data: capabilities, isLoading: capsLoading } = useBackendCapabilities();
  const refresh = useRefreshBackendCapabilities();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Cluster</h1>
        <p className="text-text-muted text-sm mt-1">
          Control-plane / data-plane topology and probed backend protocol
          capabilities.
        </p>
      </div>

      {/* Cluster status */}
      {clusterLoading && <SkeletonCard />}
      {cluster && isCpStatus(cluster) && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-4">
              <Badge variant="blue" className="px-3 py-1">CONTROL PLANE</Badge>
              <span className="text-sm text-text-secondary">
                {cluster.connected_data_planes} data plane(s) ·{" "}
                {cluster.connected_mesh_nodes} mesh node(s) connected
              </span>
            </div>
          </Card>
          {[
            { title: "Data Planes", nodes: cluster.data_planes },
            { title: "Mesh Nodes", nodes: cluster.mesh_nodes },
          ].map(({ title, nodes }) => (
            <Card key={title} className="overflow-hidden p-0">
              <div className="px-6 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
              </div>
              {nodes.length === 0 && (
                <EmptyState title={`No ${title.toLowerCase()} connected`} description="" />
              )}
              {nodes.map((node) => (
                <div
                  key={node.node_id}
                  className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary font-medium">{node.node_id}</p>
                    <p className="text-xs text-text-muted">
                      v{node.version} · ns {node.namespace} · connected{" "}
                      {formatDate(node.connected_at)} · last sync {formatDate(node.last_sync_at)}
                    </p>
                  </div>
                  <Badge variant="green">online</Badge>
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
      {cluster && isDpStatus(cluster) && (
        <Card>
          <div className="flex items-center gap-4 mb-3">
            <Badge variant="purple" className="px-3 py-1">DATA PLANE</Badge>
            <Badge variant={cluster.control_plane.status === "online" ? "green" : "red"}>
              CP {cluster.control_plane.status}
            </Badge>
            {cluster.control_plane.config_diverged && (
              <Badge variant="red">config diverged</Badge>
            )}
          </div>
          <div className="space-y-1 text-sm text-text-secondary">
            <p>
              Control plane:{" "}
              <span className="font-mono text-text-primary">{cluster.control_plane.url}</span>
              {cluster.control_plane.is_primary ? " (primary)" : ""}
            </p>
            <p>Connected since: {formatDate(cluster.control_plane.connected_since)}</p>
            <p>Last config received: {formatDate(cluster.control_plane.last_config_received_at)}</p>
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

      {/* Backend capabilities */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Backend Capabilities
            </h2>
            <p className="text-text-muted text-sm">
              Probed protocol support per backend (HTTP/1.1, H2, H3, gRPC, HBONE).
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={refresh.isPending}
            onClick={async () => {
              try {
                await refresh.mutateAsync();
                toast("success", "Backend probes refreshed");
              } catch (err) {
                toast("error", await getApiErrorMessage(err, "Refresh failed"));
              }
            }}
          >
            Re-probe All
          </Button>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-[2fr_4rem_4rem_4rem_5rem_4rem_4rem] gap-3 px-6 py-3 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
            <span>Backend</span>
            <span>H1</span>
            <span>H2/TLS</span>
            <span>H3</span>
            <span>gRPC h2c</span>
            <span>HBONE</span>
            <span>Probed</span>
          </div>
          {capsLoading && <div className="px-6 py-8 text-text-muted text-sm">Loading…</div>}
          {!capsLoading && (capabilities?.entries ?? []).length === 0 && (
            <EmptyState
              title="No backend probes yet"
              description="Capabilities are collected as proxies dispatch to backends, or on demand via Re-probe All."
            />
          )}
          {(capabilities?.entries ?? []).map((entry) => (
            <div
              key={entry.key}
              className="grid grid-cols-[2fr_4rem_4rem_4rem_5rem_4rem_4rem] gap-3 px-6 py-3 border-b border-border/50 last:border-b-0 items-center"
            >
              <div className="min-w-0">
                <p className="text-xs font-mono text-text-primary truncate">
                  {entry.key.split("|").slice(0, 3).join(" · ")}
                </p>
                {entry.last_probe_error && (
                  <p className="text-xs text-danger truncate">{entry.last_probe_error}</p>
                )}
              </div>
              <span>{supportBadge(entry.plain_http.h1)}</span>
              <span>{supportBadge(entry.plain_http.h2_tls)}</span>
              <span>{supportBadge(entry.plain_http.h3)}</span>
              <span>{supportBadge(entry.grpc_transport.h2c)}</span>
              <span>{supportBadge(entry.hbone)}</span>
              <span className="text-xs text-text-muted">
                {entry.last_probe_at_unix_secs
                  ? new Date(entry.last_probe_at_unix_secs * 1000).toLocaleTimeString()
                  : "—"}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
