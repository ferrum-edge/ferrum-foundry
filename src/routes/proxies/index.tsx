/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Proxy list page                                   */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProxies } from "@/hooks/useProxies";
import { useUpstreams } from "@/hooks/useUpstreams";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { Proxy } from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatBackend(proxy: Proxy): string {
  return `${proxy.backend_protocol}://${proxy.backend_host}:${proxy.backend_port}`;
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
  const { data: upstreamData } = useUpstreams({ limit: 1000 });
  const upstreamNameMap = useMemo(() => {
    const map = new Map<string, string>();
    const upstreams = upstreamData?.data ?? [];
    for (const u of upstreams) {
      map.set(u.id, u.name ?? u.id);
    }
    return map;
  }, [upstreamData]);

  const { data, isLoading, isError } = useProxies();
  const total = data?.pagination?.total ?? 0;
  const { offset, limit, paginationParams } = usePagination(total);

  /* Re-fetch when pagination params change */
  const { data: paginatedData, isLoading: isPaginating } = useProxies(paginationParams);
  const proxies = paginatedData?.data ?? data?.data ?? [];

  /* --- Client-side search filter --- */
  const filtered = useMemo(() => {
    if (!search.trim()) return proxies;
    const q = search.toLowerCase();
    return proxies.filter(
      (p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        p.id.toLowerCase().includes(q) ||
        p.listen_path.toLowerCase().includes(q) ||
        p.backend_host.toLowerCase().includes(q),
    );
  }, [proxies, search]);

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
        onChange={setSearch}
        placeholder="Search by name, listen path, ID, or backend host..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className="grid grid-cols-[2fr_1.5fr_2fr_4rem_1fr] gap-4 px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider">
          {columns.map((col) => (
            <span key={col.key} className={"className" in col ? col.className : ""}>
              {col.label}
            </span>
          ))}
        </div>

        {/* Body */}
        {(isLoading || isPaginating) && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {!isLoading && !isPaginating && isError && (
          <EmptyState
            title="Failed to load proxies"
            description="An error occurred while fetching proxy configurations."
          />
        )}

        {!isLoading && !isPaginating && !isError && filtered.length === 0 && (
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

        {!isLoading && !isPaginating && filtered.length > 0 && (
          <div className="divide-y divide-border/50">
            {filtered.map((proxy) => (
              <button
                key={proxy.id}
                type="button"
                className="grid grid-cols-[2fr_1.5fr_2fr_4rem_1fr] gap-4 px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer"
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
                      <span className="text-sm text-text-primary font-medium break-all">
                        {proxy.name}
                      </span>
                      <span className="text-xs text-text-muted font-mono break-all block">
                        {proxy.id}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-text-primary font-mono break-all">
                      {proxy.id}
                    </span>
                  )}
                </div>

                {/* Listen Path */}
                <span className="text-sm text-text-secondary font-mono break-all">
                  {proxy.listen_path}
                </span>

                {/* Backend / Upstream */}
                <div className="min-w-0">
                  {proxy.upstream_id ? (
                    <>
                      <span className="text-sm text-text-primary break-all">
                        {upstreamNameMap.get(proxy.upstream_id) ?? proxy.upstream_id}
                      </span>
                      <span className="text-xs text-text-muted block">load balanced</span>
                    </>
                  ) : (
                    <span className="text-sm text-text-secondary font-mono break-all">
                      {formatBackend(proxy)}
                    </span>
                  )}
                </div>

                {/* Plugins count */}
                <span className="text-center">
                  <Badge variant={proxy.plugins.length > 0 ? "blue" : "default"}>
                    {proxy.plugins.length}
                  </Badge>
                </span>

                {/* Created at */}
                <span className="text-sm text-text-muted">
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
          offset={offset}
          limit={limit}
          total={total}
          onChange={({ offset: newOffset, limit: newLimit }) => {
            // usePagination handles URL sync, but PaginationControls needs the callback
            // We re-navigate with search params
            navigate({
              search: (prev: Record<string, unknown>) => ({
                ...prev,
                offset: newOffset,
                limit: newLimit,
              }),
              replace: true,
            } as any);
          }}
        />
      )}
    </div>
  );
}
