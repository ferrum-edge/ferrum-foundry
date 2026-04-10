/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin configs list page                          */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { usePluginConfigs } from "@/hooks/usePlugins";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { PluginConfig } from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPluginName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

const columns = [
  { key: "plugin_name", label: "Plugin", className: "w-1/5" },
  { key: "scope", label: "Scope", className: "w-24" },
  { key: "proxy_id", label: "Proxy ID", className: "w-1/5" },
  { key: "enabled", label: "Enabled", className: "w-20 text-center" },
  { key: "priority", label: "Priority", className: "w-20 text-center" },
  { key: "created_at", label: "Created", className: "w-1/5 text-right" },
] as const;

/* ================================================================== */
/*  PluginsPage                                                        */
/* ================================================================== */

export default function PluginsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const { data, isLoading, isError } = usePluginConfigs();
  const total = data?.pagination?.total ?? 0;
  const { offset, limit, paginationParams } = usePagination(total);

  const { data: paginatedData, isLoading: isPaginating } = usePluginConfigs(paginationParams);
  const configs = paginatedData?.data ?? data?.data ?? [];

  /* --- Client-side search filter --- */
  const filtered = useMemo(() => {
    if (!search.trim()) return configs;
    const q = search.toLowerCase();
    return configs.filter(
      (c) =>
        c.plugin_name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.proxy_id && c.proxy_id.toLowerCase().includes(q)),
    );
  }, [configs, search]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Plugins</h1>
          <p className="text-text-muted text-sm mt-1">
            Browse and configure gateway plugin instances for authentication, rate limiting, transforms, and more.
          </p>
        </div>
        <Button onClick={() => navigate({ to: "/plugins/new" })}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Create Plugin
        </Button>
      </div>

      {/* Search */}
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Search by plugin name, ID, or proxy ID..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_6rem_1fr_5rem_5rem_1fr] gap-4 px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider">
          {columns.map((col) => (
            <span key={col.key} className={col.className}>
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
            title="Failed to load plugins"
            description="An error occurred while fetching plugin configurations."
          />
        )}

        {!isLoading && !isPaginating && !isError && filtered.length === 0 && (
          <EmptyState
            title={search ? "No matching plugins" : "No plugin configs yet"}
            description={
              search
                ? "Try adjusting your search terms."
                : "Create your first plugin configuration to extend gateway functionality."
            }
            action={
              !search ? (
                <Button size="sm" onClick={() => navigate({ to: "/plugins/new" })}>
                  Create Plugin
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !isPaginating && filtered.length > 0 && (
          <div className="divide-y divide-border/50">
            {filtered.map((config) => (
              <button
                key={config.id}
                type="button"
                className="grid grid-cols-[1fr_6rem_1fr_5rem_5rem_1fr] gap-4 px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer"
                onClick={() =>
                  navigate({
                    to: "/plugins/$pluginId",
                    params: { pluginId: config.id },
                  })
                }
              >
                {/* Plugin name */}
                <div className="min-w-0">
                  <Badge variant="orange">{formatPluginName(config.plugin_name)}</Badge>
                  <span className="text-xs text-text-muted font-mono truncate block mt-1">
                    {config.id.slice(0, 8)}...
                  </span>
                </div>

                {/* Scope */}
                <span>
                  <Badge variant={config.scope === "global" ? "blue" : "orange"}>
                    {config.scope}
                  </Badge>
                </span>

                {/* Proxy ID */}
                <span className="text-sm text-text-muted font-mono truncate">
                  {config.proxy_id ? (
                    <span>{config.proxy_id.slice(0, 12)}...</span>
                  ) : (
                    <span className="italic">--</span>
                  )}
                </span>

                {/* Enabled */}
                <span className="text-center">
                  <Badge variant={config.enabled ? "green" : "red"}>
                    {config.enabled ? "Yes" : "No"}
                  </Badge>
                </span>

                {/* Priority */}
                <span className="text-sm text-text-secondary text-center">
                  {config.priority_override !== undefined ? config.priority_override : "--"}
                </span>

                {/* Created at */}
                <span className="text-sm text-text-muted text-right">
                  {formatDate(config.created_at)}
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
