/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy list page                                   */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAllProxies, useProxies } from "@/hooks/useProxies";
import { useAllUpstreams } from "@/hooks/useUpstreams";
import { useAllPluginConfigs } from "@/hooks/usePlugins";
import { usePaginationParams } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { PluginConfig, Proxy } from "@/api/types";
import { filterAndPage } from "@/lib/collectionSearch";
import {
  effectivePluginsForProxy,
  inapplicablePluginsForProxy,
  type EffectivePlugin,
} from "@/lib/effectivePolicy";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatBackend(proxy: Proxy): string {
  return `${proxy.backend_scheme ?? "https"}://${proxy.backend_host}:${proxy.backend_port}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface PluginSummary {
  /** Plugins the gateway actually runs for this proxy. */
  total: number;
  /** Human-readable breakdown of where that number comes from. */
  breakdown: string;
}

/**
 * `GET /proxies` only carries direct proxy-scoped attachments, so
 * `proxy.plugins.length` is not the number of plugins that run. Compute the
 * same effective set the proxy detail page shows: global + direct +
 * proxy-group, minus anything the proxy's protocol never invokes.
 */
function summarizePlugins(proxy: Proxy, pluginConfigs: PluginConfig[]): PluginSummary {
  const effective = effectivePluginsForProxy(proxy, pluginConfigs);
  const counted = (source: EffectivePlugin["effectiveSource"]) =>
    effective.filter((plugin) => plugin.effectiveSource === source).length;

  const breakdown = [
    `${counted("proxy")} direct`,
    `${counted("global")} global`,
    `${counted("proxy_group")} group`,
  ];
  const skipped = inapplicablePluginsForProxy(proxy, pluginConfigs).length;
  if (skipped > 0) {
    breakdown.push(`${skipped} not applied (HTTP only)`);
  }

  return { total: effective.length, breakdown: breakdown.join(" · ") };
}

/**
 * Effective plugin count cell. Until the plugin collection resolves there is
 * no honest number to print, so show a muted placeholder rather than 0.
 */
function PluginCountCell({
  summary,
  unavailable,
}: {
  summary?: PluginSummary;
  unavailable: boolean;
}) {
  if (!summary) {
    return (
      <span
        className="text-center text-sm text-text-muted"
        title={
          unavailable
            ? "Effective plugin count unavailable"
            : "Counting effective plugins"
        }
      >
        &hellip;
      </span>
    );
  }

  return (
    <span className="text-center" title={summary.breakdown}>
      <Badge variant={summary.total > 0 ? "blue" : "default"}>
        {summary.total}
      </Badge>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

const columns = [
  { key: "name", label: "Name / ID" },
  { key: "listen_path", label: "Listen Path" },
  { key: "backend", label: "Backend / Upstream" },
  { key: "plugins", label: "Plugins", className: "text-center" },
  { key: "created_at", label: "Created" },
] as const;

/* ================================================================== */
/*  ProxiesPage                                                        */
/* ================================================================== */

export default function ProxiesPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const pagination = usePaginationParams();
  const searching = search.trim().length > 0;
  const { data: upstreamData } = useAllUpstreams();
  const upstreamNameMap = useMemo(() => {
    const map = new Map<string, string>();
    const upstreams = upstreamData ?? [];
    for (const u of upstreams) {
      map.set(u.id, u.name ?? u.id);
    }
    return map;
  }, [upstreamData]);

  const pageQuery = useProxies(pagination.paginationParams, !searching);
  const allQuery = useAllProxies(searching);
  const searchPage = useMemo(
    () =>
      filterAndPage(
        allQuery.data ?? [],
        search,
        (proxy, query) =>
          Boolean(proxy.name?.toLowerCase().includes(query)) ||
          proxy.id.toLowerCase().includes(query) ||
          (proxy.listen_path ?? "").toLowerCase().includes(query) ||
          (proxy.backend_host ?? "").toLowerCase().includes(query),
        pagination.offset,
        pagination.limit,
      ),
    [allQuery.data, pagination.limit, pagination.offset, search],
  );
  const proxies = useMemo(
    () => (searching ? searchPage.items : (pageQuery.data?.data ?? [])),
    [searching, searchPage.items, pageQuery.data],
  );
  const total = searching
    ? searchPage.total
    : (pageQuery.data?.pagination?.total ?? 0);
  const isLoading = searching ? allQuery.isLoading : pageQuery.isLoading;
  const isError = searching ? allQuery.isError : pageQuery.isError;

  /* --- Effective plugin counts (global + direct + group, protocol-filtered) --- */
  const {
    data: allPluginConfigs,
    isError: pluginConfigsError,
  } = useAllPluginConfigs();
  const pluginSummaries = useMemo(() => {
    const map = new Map<string, PluginSummary>();
    if (!allPluginConfigs) return map;
    for (const proxy of proxies) {
      map.set(proxy.id, summarizePlugins(proxy, allPluginConfigs));
    }
    return map;
  }, [allPluginConfigs, proxies]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Proxies</h1>
          <p className="text-text-muted text-sm mt-1">
            Manage API proxy configurations, routes, and upstream mappings.
          </p>
        </div>
        <Button onClick={() => navigate({ to: "/proxies/new" })}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Create Proxy
        </Button>
      </div>

      {/* Search */}
      <SearchBar
        value={search}
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by name, listen path, ID, or backend host..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,2fr)_4rem_max-content] gap-4 px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider">
          {columns.map((col) => (
            <span key={col.key} className={"className" in col ? col.className : ""}>
              {col.label}
            </span>
          ))}
        </div>

        {/* Body */}
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {!isLoading && isError && (
          <EmptyState
            title="Failed to load proxies"
            description="An error occurred while fetching proxy configurations."
          />
        )}

        {!isLoading && !isError && proxies.length === 0 && (
          <EmptyState
            title={search ? "No matching proxies" : "No proxies yet"}
            description={
              search
                ? "Try adjusting your search terms."
                : "Create your first proxy to start routing traffic."
            }
            action={
              !search ? (
                <Button size="sm" onClick={() => navigate({ to: "/proxies/new" })}>
                  Create Proxy
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !isError && proxies.length > 0 && (
          <div className="divide-y divide-border/50">
            {proxies.map((proxy) => (
              <button
                key={proxy.id}
                type="button"
                className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,2fr)_4rem_max-content] gap-4 px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer"
                onClick={() =>
                  navigate({
                    to: "/proxies/$proxyId",
                    params: { proxyId: proxy.id },
                  })
                }
              >
                {/* Name / ID */}
                <div className="min-w-0">
                  {proxy.name ? (
                    <>
                      <span className="text-sm text-text-primary font-medium truncate block" title={proxy.name}>
                        {proxy.name}
                      </span>
                      <span className="text-xs text-text-muted font-mono truncate block" title={proxy.id}>
                        {proxy.id}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-text-primary font-mono truncate block" title={proxy.id}>
                      {proxy.id}
                    </span>
                  )}
                </div>

                {/* Listen Path */}
                <span
                  className="text-sm text-text-secondary font-mono truncate min-w-0"
                  title={proxy.listen_path ?? undefined}
                >
                  {proxy.listen_path}
                </span>

                {/* Backend / Upstream */}
                <div className="min-w-0">
                  {proxy.upstream_id ? (
                    <>
                      <span
                        className="text-sm text-text-primary truncate block"
                        title={upstreamNameMap.get(proxy.upstream_id) ?? proxy.upstream_id}
                      >
                        {upstreamNameMap.get(proxy.upstream_id) ?? proxy.upstream_id}
                      </span>
                      <span className="text-xs text-text-muted block">load balanced</span>
                    </>
                  ) : (
                    <span
                      className="text-sm text-text-secondary font-mono truncate block"
                      title={formatBackend(proxy)}
                    >
                      {formatBackend(proxy)}
                    </span>
                  )}
                </div>

                {/* Effective plugin count. `proxy.plugins` holds direct
                    attachments only, so it is never the number that runs. */}
                <PluginCountCell
                  summary={pluginSummaries.get(proxy.id)}
                  unavailable={pluginConfigsError}
                />

                {/* Created at */}
                <span className="text-sm text-text-muted whitespace-nowrap">
                  {formatDate(proxy.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Pagination */}
      {total > 0 && (
        <PaginationControls
          offset={pagination.offset}
          limit={pagination.limit}
          total={total}
          onChange={pagination.setParams}
        />
      )}
    </div>
  );
}
