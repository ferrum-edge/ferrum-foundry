/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer list page                                */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAllConsumers, useConsumers } from "@/hooks/useConsumers";
import { usePaginationParams } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { Consumer } from "@/api/types";
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

const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  keyauth: "Key Auth",
  basicauth: "Basic Auth",
  jwt: "JWT",
  hmac_auth: "HMAC",
  mtls_auth: "mTLS",
};

const CREDENTIAL_BADGE_VARIANT: Record<
  string,
  "orange" | "blue" | "green" | "purple" | "yellow"
> = {
  keyauth: "orange",
  basicauth: "blue",
  jwt: "green",
  hmac_auth: "purple",
  mtls_auth: "yellow",
};

function getCredentialTypes(consumer: Consumer): string[] {
  if (!consumer.credentials || typeof consumer.credentials !== "object") {
    return [];
  }
  return Object.keys(consumer.credentials).filter((key) => {
    const val = consumer.credentials[key];
    if (Array.isArray(val)) return val.length > 0;
    return val !== null && val !== undefined;
  });
}

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

const columns = [
  { key: "username", label: "Username" },
  { key: "custom_id", label: "Custom ID" },
  { key: "acl_groups", label: "ACL Groups" },
  { key: "credentials", label: "Credentials" },
  { key: "created_at", label: "Created" },
] as const;

/* ================================================================== */
/*  ConsumersPage                                                      */
/* ================================================================== */

/*
 * The header row and each body row are separate grid containers, so labels
 * only line up with the values under them when the template resolves to the
 * same tracks in both. A content-sized last track (`max-content`) measured
 * the short "CREATED" label in the header and a full timestamp in the rows,
 * which shifted every flexible column between the two. Every track here is
 * a fixed length or a `minmax(0, fr)`, so both containers agree by
 * construction.
 */
const GRID_TEMPLATE = "grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_10rem] gap-4";

export default function ConsumersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const pagination = usePaginationParams();
  const searching = search.trim().length > 0;
  const pageQuery = useConsumers(pagination.paginationParams, !searching);
  const allQuery = useAllConsumers(searching);
  const searchPage = useMemo(
    () =>
      filterAndPage(
        allQuery.data ?? [],
        search,
        (consumer, query) =>
          consumer.username.toLowerCase().includes(query) ||
          Boolean(consumer.custom_id?.toLowerCase().includes(query)),
        pagination.offset,
        pagination.limit,
      ),
    [allQuery.data, pagination.limit, pagination.offset, search],
  );
  const consumers = searching ? searchPage.items : (pageQuery.data?.data ?? []);
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
          <h1 className="text-2xl font-bold text-text-primary">Consumers</h1>
          <p className="text-text-muted text-sm mt-1">
            Manage API consumers, their credentials, and access control
            policies.
          </p>
        </div>
        <Button onClick={() => navigate({ to: "/consumers/new" })}>
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4v16m8-8H4"
            />
          </svg>
          Create Consumer
        </Button>
      </div>

      {/* Search */}
      <SearchBar
        value={search}
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by username or custom ID..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className={`${GRID_TEMPLATE} px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider`}>
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
            title="Failed to load consumers"
            description="An error occurred while fetching consumer data."
          />
        )}

        {!isLoading && !isError && consumers.length === 0 && (
          <EmptyState
            title={total > 0 ? "No results on this page" : search ? "No matching consumers" : "No consumers yet"}
            description={
              total > 0
                ? "Use Go to last page below to return to the available results."
                : search
                ? "Try adjusting your search terms."
                : "Create your first consumer to start managing API access."
            }
            action={
              total === 0 && !search ? (
                <Button
                  size="sm"
                  onClick={() => navigate({ to: "/consumers/new" })}
                >
                  Create Consumer
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !isError && consumers.length > 0 && (
          <div className="divide-y divide-border/50">
            {consumers.map((consumer) => {
              const credTypes = getCredentialTypes(consumer);
              const groupsToShow = consumer.acl_groups.slice(0, 3);
              const extraGroups = consumer.acl_groups.length - 3;

              return (
                <button
                  key={consumer.id}
                  type="button"
                  className={`${GRID_TEMPLATE} px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer`}
                  onClick={() =>
                    navigate({
                      to: "/consumers/$consumerId",
                      params: { consumerId: consumer.id },
                    })
                  }
                >
                  {/* Username */}
                  <div className="min-w-0">
                    <span className="text-sm text-text-primary font-medium truncate block" title={consumer.username}>
                      {consumer.username}
                    </span>
                    <span className="text-xs text-text-muted font-mono truncate block" title={consumer.id}>
                      {consumer.id}
                    </span>
                  </div>

                  {/* Custom ID */}
                  <span
                    className="text-sm text-text-secondary truncate min-w-0"
                    title={consumer.custom_id ?? undefined}
                  >
                    {consumer.custom_id || (
                      <span className="text-text-muted italic">None</span>
                    )}
                  </span>

                  {/* ACL Groups */}
                  <div className="flex flex-wrap items-center gap-1">
                    {groupsToShow.length > 0 ? (
                      <>
                        {groupsToShow.map((group) => (
                          <Badge key={group} variant="blue">
                            {group}
                          </Badge>
                        ))}
                        {extraGroups > 0 && (
                          <Badge variant="default">+{extraGroups} more</Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-text-muted text-sm italic">
                        None
                      </span>
                    )}
                  </div>

                  {/* Credential types */}
                  <div className="flex flex-wrap items-center gap-1">
                    {credTypes.length > 0 ? (
                      credTypes.map((type) => (
                        <Badge
                          key={type}
                          variant={CREDENTIAL_BADGE_VARIANT[type] ?? "default"}
                        >
                          {CREDENTIAL_TYPE_LABELS[type] ?? type}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-text-muted text-sm italic">
                        None
                      </span>
                    )}
                  </div>

                  {/* Created at */}
                  <span className="text-sm text-text-muted whitespace-nowrap">
                    {formatDate(consumer.created_at)}
                  </span>
                </button>
              );
            })}
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
