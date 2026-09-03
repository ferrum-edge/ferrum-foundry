/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy detail / edit page                          */
/* ------------------------------------------------------------------ */

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useProxy, useUpdateProxy, useDeleteProxy } from "@/hooks/useProxies";
import { useAllPluginConfigs } from "@/hooks/usePlugins";
import { useUpstream } from "@/hooks/useUpstreams";
import { useAllConsumers } from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { ProxyForm } from "@/components/forms/ProxyForm";
import { Badge } from "@/components/ui/Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { getApiErrorMessage } from "@/api/client";
import * as proxiesApi from "@/api/proxies";
import {
  analyzeProxyPolicy,
  inapplicablePluginsForProxy,
} from "@/lib/effectivePolicy";
import type { ProxyCreate, PluginConfig } from "@/api/types";

/**
 * Plugin config JSON preview. Scrolls in both axes inside a bounded box so a
 * long line is never clipped mid-glyph by a horizontal-only overflow.
 */
function PluginConfigPreview({ config }: { config: Record<string, unknown> }) {
  return (
    <div className="bg-bg-secondary rounded p-2 max-h-40 overflow-auto">
      <pre className="text-xs text-text-muted whitespace-pre">
        {JSON.stringify(config, null, 2)}
      </pre>
    </div>
  );
}

export default function ProxyDetailPage() {
  const { proxyId } = useParams({ strict: false }) as { proxyId: string };
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: proxy, isLoading, isError } = useProxy(proxyId);
  const updateProxy = useUpdateProxy();
  const deleteProxy = useDeleteProxy();

  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: allPluginConfigs } = useAllPluginConfigs();
  const { data: allConsumers } = useAllConsumers();

  // Fetch upstream if the proxy has one linked
  const { data: upstream, isLoading: upstreamLoading } = useUpstream(
    proxy?.upstream_id ?? "",
  );

  const policy = useMemo(
    () => proxy
      ? analyzeProxyPolicy(proxy, allPluginConfigs ?? [], allConsumers ?? [])
      : undefined,
    [proxy, allPluginConfigs, allConsumers],
  );
  const proxyPlugins = policy?.effectivePlugins ?? [];
  // Attached but never invoked: HTTP-only plugins on a TCP/UDP listener.
  const skippedPlugins = useMemo(
    () => (proxy ? inapplicablePluginsForProxy(proxy, allPluginConfigs ?? []) : []),
    [proxy, allPluginConfigs],
  );
  const visibleConsumers = policy?.consumers.filter(
    (result) => result.decision === "allowed" || result.decision === "conditional",
  ) ?? [];

  /* ---------- Handlers ---------- */

  const handleSubmit = async (data: ProxyCreate) => {
    if (!proxy) return;
    try {
      await updateProxy.mutateAsync({
        id: proxyId,
        data: proxiesApi.mergeFormUpdatePayload(proxy, data),
      });
      toast("success", "Proxy updated successfully");
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to update proxy");
      toast("error", message);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteProxy.mutateAsync(proxyId);
      toast("success", "Proxy deleted successfully");
      navigate({ to: "/proxies" });
    } catch (err: unknown) {
      const message = await getApiErrorMessage(err, "Failed to delete proxy");
      toast("error", message);
    }
  };

  /* ---------- Loading / Error states ---------- */

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (isError || !proxy) {
    return (
      <div className="max-w-2xl">
        <Card>
          <p className="text-text-secondary">
            Failed to load proxy configuration.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => navigate({ to: "/proxies" })}
          >
            Back to Proxies
          </Button>
        </Card>
      </div>
    );
  }

  /* ---------- Render ---------- */

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {proxy.name || "Proxy Detail"}
          </h1>
          <p className="text-text-muted text-sm mt-1 font-mono">{proxy.id}</p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
          Delete
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="plugins">
            Plugins ({proxyPlugins.length})
          </TabsTrigger>
          <TabsTrigger value="consumers">
            Consumers
          </TabsTrigger>
          <TabsTrigger value="upstream">
            {proxy.upstream_id ? "Upstream (linked)" : "Upstream"}
          </TabsTrigger>
        </TabsList>

        {/* ── Config Tab ─────────────────────────────────────────── */}
        <TabsContent value="config">
          <Card>
            <ProxyForm
              initialData={proxy}
              onSubmit={handleSubmit}
              isLoading={updateProxy.isPending}
            />
          </Card>
        </TabsContent>

        {/* ── Plugins Tab ────────────────────────────────────────── */}
        <TabsContent value="plugins">
          <div className="space-y-3">
            {proxyPlugins.length === 0 ? (
              <Card>
                <div className="text-center py-8">
                  <p className="text-text-secondary mb-4">
                    No plugins run on this proxy.
                  </p>
                  <Link
                    to="/plugins/new"
                    className="text-orange hover:text-orange-light font-medium transition-colors"
                  >
                    Create a plugin
                  </Link>
                </div>
              </Card>
            ) : (
              <>
                {/* Plugin association IDs from the proxy object */}
                {(proxy.plugins ?? []).length > 0 && (
                  <Card>
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      Plugin Associations
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {(proxy.plugins ?? []).map((assoc) => (
                        <Link
                          key={assoc.plugin_config_id}
                          to="/plugins/$pluginId"
                          params={{ pluginId: assoc.plugin_config_id }}
                          className="font-mono text-xs text-orange hover:text-orange-light transition-colors"
                        >
                          <Badge variant="orange">{assoc.plugin_config_id}</Badge>
                        </Link>
                      ))}
                    </div>
                  </Card>
                )}

                {/* Scoped plugin configs */}
                {proxyPlugins.map((plugin: PluginConfig) => (
                  <Link
                    key={plugin.id}
                    to="/plugins/$pluginId"
                    params={{ pluginId: plugin.id }}
                    className="block"
                  >
                    <Card className="hover:border-orange/40 transition-colors cursor-pointer">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-text-primary">
                          {plugin.plugin_name}
                        </span>
                        <Badge variant={plugin.enabled ? "green" : "red"}>
                          {plugin.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <PluginConfigPreview config={plugin.config} />
                    </Card>
                  </Link>
                ))}
              </>
            )}

            {/* Attached but never invoked on an L4 listener */}
            {skippedPlugins.length > 0 && (
              <Card>
                <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">
                  Not applied on this stream proxy
                </h3>
                <p className="text-text-muted text-sm mt-1 mb-3">
                  The gateway skips HTTP-only plugins on TCP/UDP listeners.
                </p>
                <div className="space-y-2">
                  {skippedPlugins.map((plugin) => (
                    <Link
                      key={plugin.id}
                      to="/plugins/$pluginId"
                      params={{ pluginId: plugin.id }}
                      className="block rounded-lg border border-border p-3 opacity-70 hover:opacity-100 transition-opacity"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-text-secondary">
                          {plugin.plugin_name}
                        </span>
                        <Badge variant="default">HTTP only</Badge>
                      </div>
                      <PluginConfigPreview config={plugin.config} />
                    </Link>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ── Consumers Tab ──────────────────────────────────────── */}
        <TabsContent value="consumers">
          {!policy || policy.authPlugins.length === 0 ? (
            <Card>
              <div className="flex flex-col items-center text-center py-8">
                <p className="text-text-secondary">
                  No consumers are authorized for this proxy.
                </p>
                <p className="text-text-muted text-sm mt-2 max-w-md">
                  Attach an authentication plugin such as key auth, basic auth,
                  JWT, or mTLS to this proxy, or globally, to control who can
                  call it.
                </p>
                <Link to="/plugins/new" className="mt-4">
                  <Button size="sm" variant="secondary">
                    Add an authentication plugin
                  </Button>
                </Link>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              <Card>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <Badge variant={policy.conditional ? "yellow" : "green"}>
                    {policy.conditional ? "Conditional" : "Evaluated"}
                  </Badge>
                  {policy.authPlugins.map((plugin) => (
                    <Badge key={plugin.id} variant="blue">
                      {plugin.plugin_name} · {plugin.effectiveSource}
                    </Badge>
                  ))}
                </div>
                <p className="text-text-muted text-xs">
                  Complete gateway pagination · evaluated {new Date(policy.evaluatedAt).toLocaleString()}
                  {policy.latestConfigUpdate
                    ? ` · newest policy update ${new Date(policy.latestConfigUpdate).toLocaleString()}`
                    : ""}
                </p>
                {policy.reasons.map((reason) => (
                  <p key={reason} className="text-warning text-xs mt-2">{reason}</p>
                ))}
              </Card>

              <Card className="p-0 overflow-hidden">
                <div className="grid grid-cols-[2fr_1fr_2fr] gap-4 px-5 py-2.5 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
                  <span>Username</span>
                  <span>Decision</span>
                  <span>Evidence</span>
                </div>
                <div className="max-h-[400px] overflow-y-auto divide-y divide-border/50">
                  {visibleConsumers.map((result) => (
                    <Link
                      key={result.consumer.id}
                      to="/consumers/$consumerId"
                      params={{ consumerId: result.consumer.id }}
                      className="grid grid-cols-[2fr_1fr_2fr] gap-4 px-5 py-3 text-sm hover:bg-bg-card-hover transition-colors"
                    >
                      <span className="text-text-primary font-medium break-all">
                        {result.consumer.username}
                      </span>
                      <Badge variant={result.decision === "allowed" ? "green" : "yellow"}>
                        {result.decision}
                      </Badge>
                      <span className="text-text-muted text-xs">
                        {result.reasons.join("; ")}
                      </span>
                    </Link>
                  ))}
                  {visibleConsumers.length === 0 && (
                    <p className="px-5 py-6 text-sm text-text-muted">
                      No stored consumer is conclusively or conditionally matched.
                    </p>
                  )}
                </div>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ── Upstream Tab ───────────────────────────────────────── */}
        <TabsContent value="upstream">
          {!proxy.upstream_id ? (
            <Card>
              <div className="text-center py-8">
                <p className="text-text-secondary">
                  No upstream configured for this proxy.
                </p>
              </div>
            </Card>
          ) : upstreamLoading ? (
            <SkeletonCard />
          ) : !upstream ? (
            <Card>
              <p className="text-text-secondary">
                Failed to load upstream data.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Upstream summary */}
              <Card>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <Link
                      to="/upstreams/$upstreamId"
                      params={{ upstreamId: upstream.id }}
                      className="text-lg font-semibold text-orange hover:text-orange-light transition-colors"
                    >
                      {upstream.name || upstream.id}
                    </Link>
                    {upstream.name && (
                      <p className="text-text-muted text-xs font-mono mt-0.5">
                        {upstream.id}
                      </p>
                    )}
                  </div>
                  <Badge variant="blue">{upstream.algorithm.replace(/_/g, " ")}</Badge>
                </div>

                <div className="flex gap-4 text-sm text-text-secondary">
                  <span>
                    <span className="font-medium text-text-primary">
                      {upstream.targets.length}
                    </span>{" "}
                    target{upstream.targets.length !== 1 ? "s" : ""}
                  </span>
                  {upstream.health_checks?.active && (
                    <Badge variant="green">Active health checks</Badge>
                  )}
                  {upstream.health_checks?.passive && (
                    <Badge variant="yellow">Passive health checks</Badge>
                  )}
                  {!upstream.health_checks?.active &&
                    !upstream.health_checks?.passive && (
                      <Badge variant="default">No health checks</Badge>
                    )}
                </div>
              </Card>

              {/* Targets list */}
              {upstream.targets.length > 0 && (
                <Card>
                  <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                    Targets
                  </h3>
                  <div className="space-y-2">
                    {upstream.targets.map((target, idx) => (
                      <div
                        key={`${target.host}:${target.port}-${idx}`}
                        className="flex items-center justify-between py-2 border-b border-border last:border-b-0"
                      >
                        <span className="font-mono text-sm text-text-primary">
                          {target.host}:{target.port}
                          {target.path ? target.path : ""}
                        </span>
                        <Badge variant="purple">weight: {target.weight}</Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Proxy"
        description={`Are you sure you want to delete "${proxy.name || proxy.id}"? This action cannot be undone.`}
        confirmLabel="Delete Proxy"
        variant="danger"
        onConfirm={handleDelete}
        loading={deleteProxy.isPending}
      />
    </div>
  );
}
