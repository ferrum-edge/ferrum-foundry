/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy detail / edit page                          */
/* ------------------------------------------------------------------ */

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useProxy, useUpdateProxy, useDeleteProxy } from "@/hooks/useProxies";
import { usePluginConfigs } from "@/hooks/usePlugins";
import { useUpstream } from "@/hooks/useUpstreams";
import { useConsumers } from "@/hooks/useConsumers";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { ProxyForm } from "@/components/forms/ProxyForm";
import { Badge } from "@/components/ui/Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { getApiErrorMessage } from "@/api/client";
import type { ProxyCreate, PluginConfig, Consumer } from "@/api/types";

export default function ProxyDetailPage() {
  const { proxyId } = useParams({ strict: false }) as { proxyId: string };
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: proxy, isLoading, isError } = useProxy(proxyId);
  const updateProxy = useUpdateProxy();
  const deleteProxy = useDeleteProxy();

  const [deleteOpen, setDeleteOpen] = useState(false);

  // Fetch all plugin configs so we can filter by proxy_id client-side
  const { data: pluginConfigsResponse } = usePluginConfigs({ limit: 1000 });

  // Fetch upstream if the proxy has one linked
  const { data: upstream, isLoading: upstreamLoading } = useUpstream(
    proxy?.upstream_id ?? "",
  );

  // Filter plugins scoped to this proxy
  const proxyPlugins = useMemo(() => {
    if (!pluginConfigsResponse?.data) return [];
    return pluginConfigsResponse.data.filter(
      (p: PluginConfig) => p.proxy_id === proxyId,
    );
  }, [pluginConfigsResponse, proxyId]);

  // Auth analysis for the Authorized Consumers tab
  const AUTH_PLUGIN_NAMES = [
    "key_auth", "basic_auth", "jwt_auth", "jwks_auth",
    "hmac_auth", "mtls_auth", "ldap_auth",
  ];

  const { hasAuthPlugin, authPluginTypes, aclAllowGroups, aclDenyGroups } = useMemo(() => {
    const types: string[] = [];
    let allow: string[] = [];
    let deny: string[] = [];
    for (const p of proxyPlugins) {
      if (AUTH_PLUGIN_NAMES.includes(p.plugin_name)) {
        types.push(p.plugin_name);
      }
      if (p.plugin_name === "access_control" && p.config) {
        const cfg = p.config as Record<string, unknown>;
        if (Array.isArray(cfg.allow)) allow = cfg.allow as string[];
        if (Array.isArray(cfg.deny)) deny = cfg.deny as string[];
      }
    }
    return { hasAuthPlugin: types.length > 0, authPluginTypes: types, aclAllowGroups: allow, aclDenyGroups: deny };
  }, [proxyPlugins]);

  const hasAclFilter = aclAllowGroups.length > 0 || aclDenyGroups.length > 0;

  // Only fetch consumers when ACL groups are configured (otherwise we show "All consumers allowed")
  const { data: consumersResponse } = useConsumers(hasAclFilter ? { limit: 1000 } : { limit: 0 });

  // Filter consumers by ACL groups
  const authorizedConsumers = useMemo(() => {
    if (!hasAclFilter) return [];
    const allConsumers = consumersResponse?.data ?? [];
    return allConsumers.filter((c: Consumer) => {
      if (aclAllowGroups.length > 0) {
        if (!c.acl_groups.some((g) => aclAllowGroups.includes(g))) return false;
      }
      if (aclDenyGroups.length > 0) {
        if (c.acl_groups.some((g) => aclDenyGroups.includes(g))) return false;
      }
      return true;
    });
  }, [consumersResponse, hasAclFilter, aclAllowGroups, aclDenyGroups]);

  /* ---------- Handlers ---------- */

  const handleSubmit = async (data: ProxyCreate) => {
    try {
      await updateProxy.mutateAsync({
        id: proxyId,
        data: { ...data, plugins: proxy?.plugins ?? [] },
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
          {proxyPlugins.length === 0 ? (
            <Card>
              <div className="text-center py-8">
                <p className="text-text-secondary mb-4">
                  No plugins configured for this proxy.
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
            <div className="space-y-3">
              {/* Plugin association IDs from the proxy object */}
              {proxy.plugins.length > 0 && (
                <Card>
                  <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                    Plugin Associations
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {proxy.plugins.map((assoc) => (
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
                    <pre className="text-xs text-text-muted bg-bg-secondary rounded p-2 overflow-x-auto max-h-24">
                      {JSON.stringify(plugin.config, null, 2)}
                    </pre>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Consumers Tab ──────────────────────────────────────── */}
        <TabsContent value="consumers">
          {!hasAuthPlugin ? (
            <Card>
              <div className="text-center py-8">
                <p className="text-text-secondary">
                  No authentication plugins configured for this proxy.
                </p>
                <p className="text-text-muted text-sm mt-2">
                  Add an auth plugin (key_auth, basic_auth, jwt_auth, etc.) to
                  restrict access to specific consumers.
                </p>
              </div>
            </Card>
          ) : !hasAclFilter ? (
            <Card>
              <div className="py-6">
                <div className="flex items-center gap-3 mb-4">
                  <Badge variant="green">Open Access</Badge>
                  <span className="text-text-primary font-medium">
                    All authenticated consumers allowed
                  </span>
                </div>
                <p className="text-text-muted text-sm">
                  This proxy requires authentication via{" "}
                  {authPluginTypes.map((t) => t.replace(/_/g, " ")).join(", ")},
                  but has no access_control plugin restricting by ACL group. Any
                  consumer with valid credentials can access this proxy.
                </p>
                <Link
                  to="/plugins/new"
                  search={{ plugin: "access_control", scope: "proxy", proxyId: proxy.id }}
                  className="inline-block mt-4 text-sm text-orange hover:text-orange-light font-medium transition-colors"
                >
                  Add an access_control plugin to restrict by group
                </Link>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {/* ACL summary */}
              <Card>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                    ACL Groups
                  </span>
                  {aclAllowGroups.map((g) => (
                    <Badge key={`allow-${g}`} variant="green">{g}</Badge>
                  ))}
                  {aclDenyGroups.map((g) => (
                    <Badge key={`deny-${g}`} variant="red">deny: {g}</Badge>
                  ))}
                </div>
                <p className="text-text-muted text-xs">
                  {authorizedConsumers.length} consumer{authorizedConsumers.length !== 1 ? "s" : ""} match
                </p>
              </Card>

              {/* Consumer list — virtualized-ready with fixed height and scroll */}
              <Card className="p-0 overflow-hidden">
                <div className="grid grid-cols-[2fr_1.5fr_2fr] gap-4 px-5 py-2.5 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
                  <span>Username</span>
                  <span>Custom ID</span>
                  <span>ACL Groups</span>
                </div>
                <div className="max-h-[400px] overflow-y-auto divide-y divide-border/50">
                  {authorizedConsumers.map((c: Consumer) => (
                    <Link
                      key={c.id}
                      to="/consumers/$consumerId"
                      params={{ consumerId: c.id }}
                      className="grid grid-cols-[2fr_1.5fr_2fr] gap-4 px-5 py-3 text-sm hover:bg-bg-card-hover transition-colors"
                    >
                      <span className="text-text-primary font-medium break-all">
                        {c.username}
                      </span>
                      <span className="text-text-muted break-all">
                        {c.custom_id || "—"}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {c.acl_groups.map((g) => (
                          <Badge
                            key={g}
                            variant={aclAllowGroups.includes(g) ? "green" : "default"}
                          >
                            {g}
                          </Badge>
                        ))}
                      </div>
                    </Link>
                  ))}
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
