/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Consumer list page                                */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useConsumers } from "@/hooks/useConsumers";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { Consumer } from "@/api/types";

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
  { key: "username", label: "Username", className: "w-1/5" },
  { key: "custom_id", label: "Custom ID", className: "w-1/6" },
  { key: "acl_groups", label: "ACL Groups", className: "w-1/5" },
  { key: "credentials", label: "Credentials", className: "w-1/5" },
  { key: "created_at", label: "Created", className: "w-1/6 text-right" },
] as const;

/* ================================================================== */
/*  ConsumersPage                                                      */
/* ================================================================== */

export default function ConsumersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const { data, isLoading, isError } = useConsumers();
  const total = data?.pagination?.total ?? 0;
  const { offset, limit, paginationParams } = usePagination(total);

  /* Re-fetch when pagination params change */
  const { data: paginatedData, isLoading: isPaginating } =
    useConsumers(paginationParams);
  const consumers = paginatedData?.data ?? data?.data ?? [];

  /* --- Client-side search filter --- */
  const filtered = useMemo(() => {
    if (!search.trim()) return consumers;
    const q = search.toLowerCase();
    return consumers.filter(
      (c) =>
        c.username.toLowerCase().includes(q) ||
        (c.custom_id && c.custom_id.toLowerCase().includes(q)),
    );
  }, [consumers, search]);

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
        onChange={setSearch}
        placeholder="Search by username or custom ID..."
        className="max-w-md"
      />

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_1fr_1.2fr_1.2fr_1fr] gap-4 px-6 py-3 border-b border-border bg-bg-card text-text-muted text-xs font-semibold uppercase tracking-wider">
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
            title="Failed to load consumers"
            description="An error occurred while fetching consumer data."
          />
        )}

        {!isLoading && !isPaginating && !isError && filtered.length === 0 && (
          <EmptyState
            title={search ? "No matching consumers" : "No consumers yet"}
            description={
              search
                ? "Try adjusting your search terms."
                : "Create your first consumer to start managing API access."
            }
            action={
              !search ? (
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

        {!isLoading && !isPaginating && filtered.length > 0 && (
          <div className="divide-y divide-border/50">
            {filtered.map((consumer) => {
              const credTypes = getCredentialTypes(consumer);
              const groupsToShow = consumer.acl_groups.slice(0, 3);
              const extraGroups = consumer.acl_groups.length - 3;

              return (
                <button
                  key={consumer.id}
                  type="button"
                  className="grid grid-cols-[1fr_1fr_1.2fr_1.2fr_1fr] gap-4 px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/consumers/$consumerId",
                      params: { consumerId: consumer.id },
                    })
                  }
                >
                  {/* Username */}
                  <div className="min-w-0">
                    <span className="text-sm text-text-primary font-medium truncate block">
                      {consumer.username}
                    </span>
                    <span className="text-xs text-text-muted font-mono truncate block">
                      {consumer.id.slice(0, 8)}...
                    </span>
                  </div>

                  {/* Custom ID */}
                  <span className="text-sm text-text-secondary truncate">
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
                  <span className="text-sm text-text-muted text-right">
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
