/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin configs list page                          */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAllPluginConfigs, usePluginConfigs } from "@/hooks/usePlugins";
import { usePaginationParams } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { GRID_HEADER_CLASS, GRID_ROW_CLASS, ResourceGrid } from "@/components/ui/ResourceGrid";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { ReadStateNotice } from "@/components/shared/ReadState";
import { PageHeader } from "@/components/shared/PageHeader";
import { PlusIcon } from "@/components/ui/icons";
import { WriteAction } from "@/components/shared/CapabilityGate";
import { useCapabilities } from "@/stores/capabilities";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { PLUGIN_PRIORITY, formatPluginName, getPluginMeta } from "@/lib/pluginConfigDefaults";
import { filterAndPage } from "@/lib/collectionSearch";
import { EMPTY_VALUE, formatDateTime } from "@/lib/format";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function PriorityCell({ override, builtIn }: { override?: number | null; builtIn?: number }) {
  if (override != null) {
    return (
      <span
        className="text-sm"
        title={builtIn !== undefined
          ? `Priority override (built-in priority ${builtIn})`
          : "Priority override"}
      >
        <span className="block text-text-primary tabular-nums">{override}</span>
        <span className="block text-[11px] text-text-muted">override</span>
      </span>
    );
  }
  return (
    <span className="text-sm text-text-muted tabular-nums" title="Built-in priority">
      {builtIn ?? EMPTY_VALUE}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

const columns = [
  { key: "plugin_name", label: "Plugin" },
  { key: "scope", label: "Scope" },
  { key: "proxy_id", label: "Proxy ID" },
  { key: "enabled", label: "Enabled" },
  { key: "priority", label: "Priority" },
  { key: "created_at", label: "Created" },
] as const;

/* ================================================================== */
/*  PluginsPage                                                        */
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
const GRID_TEMPLATE = "grid grid-cols-[minmax(0,2fr)_4.5rem_minmax(0,1.5fr)_5rem_5rem_10rem] gap-4";

export default function PluginsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  /* --- Data fetching with pagination --- */
  const pagination = usePaginationParams();
  const searching = search.trim().length > 0;
  const pageQuery = usePluginConfigs(pagination.paginationParams, !searching);
  const allQuery = useAllPluginConfigs(searching);
  const searchPage = useMemo(
    () =>
      filterAndPage(
        allQuery.data ?? [],
        search,
        (config, query) =>
          config.plugin_name.toLowerCase().includes(query) ||
          config.id.toLowerCase().includes(query) ||
          Boolean(config.proxy_id?.toLowerCase().includes(query)),
        pagination.offset,
        pagination.limit,
      ),
    [allQuery.data, pagination.limit, pagination.offset, search],
  );
  const configs = searching ? searchPage.items : (pageQuery.data?.data ?? []);
  const total = searching
    ? searchPage.total
    : (pageQuery.data?.pagination?.total ?? 0);
  const isLoading = searching ? allQuery.isLoading : pageQuery.isLoading;
  const isError = searching ? allQuery.isError : pageQuery.isError;
  const listQuery = searching ? allQuery : pageQuery;
  const { capabilities } = useCapabilities();
  const canWrite = capabilities.pluginConfigs;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plugins"
        description="Browse and configure gateway plugin instances for authentication, rate limiting, transforms, and more."
        actions={
          <WriteAction verdict={canWrite}>
            <Button onClick={() => navigate({ to: "/plugins/new" })}>
              <PlusIcon />
              Create Plugin
            </Button>
          </WriteAction>
        }
      />

      {/* Search */}
      <SearchBar
        value={search}
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by plugin name, ID, or proxy ID..."
        className="max-w-md"
      />

      {/* Table */}
      <ResourceGrid
        label="Plugins"
        emptyState={
          <>
            {/* A refused read is a denial and an outage is unavailable. A failed
                refetch says it could not refresh and when the rows were last
                observed; stale rows are not shown as current (#298, #680). */}
            {!isLoading && isError && (
              <ReadStateNotice query={listQuery} label="Plugins" />
            )}

            {!isLoading && !isError && configs.length === 0 && (
              <EmptyState
                title={total > 0 ? "No results on this page" : search ? "No matching plugins" : "No plugin configs yet"}
                description={
                  total > 0
                    ? "Use Go to last page below to return to the available results."
                    : search
                    ? "Try adjusting your search terms."
                    : "Create your first plugin configuration to extend gateway functionality."
                }
                action={
                  total === 0 && !search ? (
                    <WriteAction verdict={canWrite} align="start">
                      <Button size="sm" onClick={() => navigate({ to: "/plugins/new" })}>
                        Create Plugin
                      </Button>
                    </WriteAction>
                  ) : undefined
                }
              />
            )}
          </>
        }
      >
        {/* Header row */}
        <div className={`${GRID_TEMPLATE} ${GRID_HEADER_CLASS}`}>
          {columns.map((col) => (
            <span key={col.key} className="whitespace-nowrap">
              {col.label}
            </span>
          ))}
        </div>

        {/* Body */}
        {isLoading && (
          <div className="px-4 divide-y divide-border/50">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {!isLoading && !isError && configs.length > 0 && (
          <div className="divide-y divide-border/50">
            {configs.map((config) => (
              <button
                key={config.id}
                type="button"
                className={`${GRID_TEMPLATE} ${GRID_ROW_CLASS} w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer`}
                onClick={() =>
                  navigate({
                    to: "/plugins/$pluginId",
                    params: { pluginId: config.id },
                  })
                }
              >
                {/* Plugin name */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="orange">{formatPluginName(config.plugin_name)}</Badge>
                    <span className="text-[11px] text-text-muted">
                      {getPluginMeta(config.plugin_name).category}
                    </span>
                    {config.trigger && <Badge variant="purple">triggered</Badge>}
                  </div>
                  <span className="text-xs text-text-muted font-mono truncate block mt-1" title={config.id}>
                    {config.id}
                  </span>
                </div>

                {/* Scope */}
                <span>
                  <Badge variant={config.scope === "global" ? "blue" : config.scope === "proxy_group" ? "purple" : "orange"}>
                    {config.scope === "proxy_group" ? "group" : config.scope}
                  </Badge>
                </span>

                {/* Proxy ID */}
                <span
                  className="text-sm text-text-muted font-mono truncate block min-w-0"
                  title={config.proxy_id ?? undefined}
                >
                  {config.proxy_id ?? EMPTY_VALUE}
                </span>

                {/* Enabled */}
                <span>
                  <Badge variant={config.enabled ? "green" : "red"}>
                    {config.enabled ? "Yes" : "No"}
                  </Badge>
                </span>

                {/* Priority — an override is an ordinary setting, not an error:
                    the number reads like any other, with a quiet label. Null
                    counts as absent, so a row never shows an empty override. */}
                <PriorityCell
                  override={config.priority_override}
                  builtIn={PLUGIN_PRIORITY[config.plugin_name]}
                />

                {/* Created at */}
                <span className="text-sm text-text-muted whitespace-nowrap">
                  {formatDateTime(config.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </ResourceGrid>

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
