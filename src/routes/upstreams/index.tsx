/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream list page                                */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAllUpstreams, useUpstreams } from "@/hooks/useUpstreams";
import { usePaginationParams } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { filterAndPage } from "@/lib/collectionSearch";

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

/*
 * The header row and every body row are separate grid containers, so the
 * template only lines labels up with the values underneath them if it resolves
 * to identical track sizes in both. That rules out content-dependent tracks: a
 * `max-content` "Created" column measured "CREATED" (~56px) in the header and
 * a formatted timestamp (~150px) in the rows, so the header's flexible columns
 * came out ~90px wider than the body's — and the two badge columns absorbed
 * the squeeze.
 *
 * Every track below is therefore a fixed length or an `fr` with an explicit
 * `minmax(0, …)`, none of which can disagree between the two containers. The
 * badge columns are sized off their *labels*, which are the widest thing in
 * them: "HEALTH CHECK" needs ~100px at text-xs/uppercase/tracking-wider, so
 * the old 5rem (80px) wrapped it onto two lines. The tracks sum to ~860px of
 * the ~860px available inside the card at a 1280px viewport and shrink from
 * the flexible columns below that, so nothing overflows or scrolls sideways.
 */
const GRID_TEMPLATE =
  "grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_5rem_7.5rem_10rem] gap-4";

/* ================================================================== */
/*  UpstreamsPage                                                      */
/* ================================================================== */

export default function UpstreamsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const pagination = usePaginationParams();
  const searching = search.trim().length > 0;
  const pageQuery = useUpstreams(pagination.paginationParams, !searching);
  const allQuery = useAllUpstreams(searching);
  const searchPage = useMemo(
    () =>
      filterAndPage(
        allQuery.data ?? [],
        search,
        (upstream, query) =>
          Boolean(upstream.name?.toLowerCase().includes(query)) ||
          upstream.id.toLowerCase().includes(query),
        pagination.offset,
        pagination.limit,
      ),
    [allQuery.data, pagination.limit, pagination.offset, search],
  );
  const upstreams = searching ? searchPage.items : (pageQuery.data?.data ?? []);
  const total = searching
    ? searchPage.total
    : (pageQuery.data?.pagination?.total ?? 0);
  const isLoading = searching ? allQuery.isLoading : pageQuery.isLoading;
  const isError = searching ? allQuery.isError : pageQuery.isError;

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
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by name or ID..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div
          className={`${GRID_TEMPLATE} px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider`}
        >
          {columns.map((col) => (
            <span key={col.key} className="whitespace-nowrap">
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
            title="Failed to load upstreams"
            description="An error occurred while fetching upstream configurations."
          />
        )}

        {!isLoading && !isError && upstreams.length === 0 && (
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

        {!isLoading && !isError && upstreams.length > 0 && (
          <div className="divide-y divide-border/50">
            {upstreams.map((upstream) => (
              <button
                key={upstream.id}
                type="button"
                className={`${GRID_TEMPLATE} px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer`}
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
                      <span className="text-sm text-text-primary font-medium truncate block" title={upstream.name}>
                        {upstream.name}
                      </span>
                      <span className="text-xs text-text-muted font-mono truncate block" title={upstream.id}>
                        {upstream.id}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-text-primary font-mono truncate block" title={upstream.id}>
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
                <span className="text-sm text-text-muted whitespace-nowrap">
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
          offset={pagination.offset}
          limit={pagination.limit}
          total={total}
          onChange={pagination.setParams}
        />
      )}
    </div>
  );
}
