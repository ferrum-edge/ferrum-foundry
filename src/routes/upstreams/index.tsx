/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream list page                                */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUpstreams } from "@/hooks/useUpstreams";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { Upstream } from "@/api/types";

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

function formatAlgorithm(algo: string): string {
  return algo.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function algorithmBadgeVariant(algo: string) {
  switch (algo) {
    case "round_robin":
      return "blue" as const;
    case "weighted_round_robin":
      return "purple" as const;
    case "least_connections":
      return "green" as const;
    case "least_latency":
      return "green" as const;
    case "consistent_hashing":
      return "orange" as const;
    case "random":
      return "default" as const;
    default:
      return "default" as const;
  }
}

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

const columns = [
  { key: "name", label: "Name / ID" },
  { key: "algorithm", label: "Algorithm" },
  { key: "targets", label: "Targets" },
  { key: "health", label: "Health Check" },
  { key: "created_at", label: "Created" },
] as const;

/* ================================================================== */
/*  UpstreamsPage                                                      */
/* ================================================================== */

export default function UpstreamsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const { data, isLoading, isError } = useUpstreams();
  const total = data?.pagination?.total ?? 0;
  const { offset, limit, paginationParams } = usePagination(total);

  const { data: paginatedData, isLoading: isPaginating } = useUpstreams(paginationParams);
  const upstreams = paginatedData?.data ?? data?.data ?? [];

  /* --- Client-side search filter --- */
  const filtered = useMemo(() => {
    if (!search.trim()) return upstreams;
    const q = search.toLowerCase();
    return upstreams.filter(
      (u) =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        u.id.toLowerCase().includes(q),
    );
  }, [upstreams, search]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Upstreams</h1>
          <p className="text-text-muted text-sm mt-1">
            Manage upstream services, targets, health checks, and load balancing strategies.
          </p>
        </div>
        <Button onClick={() => navigate({ to: "/upstreams/new" })}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Create Upstream
        </Button>
      </div>

      {/* Search */}
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Search by name or ID..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className="grid grid-cols-[2fr_1.5fr_4rem_5rem_1fr] gap-4 px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider">
          {columns.map((col) => (
            <span key={col.key}>
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
            title="Failed to load upstreams"
            description="An error occurred while fetching upstream configurations."
          />
        )}

        {!isLoading && !isPaginating && !isError && filtered.length === 0 && (
          <EmptyState
            title={search ? "No matching upstreams" : "No upstreams yet"}
            description={
              search
                ? "Try adjusting your search terms."
                : "Create your first upstream to define backend targets and load balancing."
            }
            action={
              !search ? (
                <Button size="sm" onClick={() => navigate({ to: "/upstreams/new" })}>
                  Create Upstream
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !isPaginating && filtered.length > 0 && (
          <div className="divide-y divide-border/50">
            {filtered.map((upstream) => (
              <button
                key={upstream.id}
                type="button"
                className="grid grid-cols-[2fr_1.5fr_4rem_5rem_1fr] gap-4 px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer"
                onClick={() =>
                  navigate({
                    to: "/upstreams/$upstreamId",
                    params: { upstreamId: upstream.id },
                  })
                }
              >
                {/* Name / ID */}
                <div className="min-w-0">
                  {upstream.name ? (
                    <>
                      <span className="text-sm text-text-primary font-medium break-all">
                        {upstream.name}
                      </span>
                      <span className="text-xs text-text-muted font-mono break-all block">
                        {upstream.id}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-text-primary font-mono break-all">
                      {upstream.id}
                    </span>
                  )}
                </div>

                {/* Algorithm */}
                <span>
                  <Badge variant={algorithmBadgeVariant(upstream.algorithm)}>
                    {formatAlgorithm(upstream.algorithm)}
                  </Badge>
                </span>

                {/* Target count */}
                <span>
                  <Badge variant={upstream.targets.length > 0 ? "blue" : "default"}>
                    {upstream.targets.length}
                  </Badge>
                </span>

                {/* Health check status */}
                <span>
                  {upstream.health_checks?.active || upstream.health_checks?.passive ? (
                    <Badge variant="green">Active</Badge>
                  ) : (
                    <Badge variant="default">None</Badge>
                  )}
                </span>

                {/* Created at */}
                <span className="text-sm text-text-muted">
                  {formatDate(upstream.created_at)}
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
