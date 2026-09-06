/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin configs list page                          */
/* ------------------------------------------------------------------ */

import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAllPluginConfigs, usePluginConfigs } from "@/hooks/usePlugins";
import { usePaginationParams } from "@/hooks/usePagination";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchBar } from "@/components/shared/SearchBar";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { formatPluginName, getPluginMeta } from "@/lib/pluginConfigDefaults";
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

/** Built-in plugin priorities from ferrum-edge (lower = runs first). */
const DEFAULT_PLUGIN_PRIORITY: Record<string, number> = {
  otel_tracing: 25,
  correlation_id: 50,
  cors: 100,
  request_termination: 125,
  ip_restriction: 150,
  geo_restriction: 175,
  bot_detection: 200,
  sse: 250,
  grpc_web: 260,
  grpc_method_router: 275,
  mtls_auth: 950,
  jwks_auth: 1000,
  jwt_auth: 1100,
  key_auth: 1200,
  ldap_auth: 1250,
  basic_auth: 1300,
  hmac_auth: 1400,
  soap_ws_security: 1500,
  access_control: 2000,
  tcp_connection_throttle: 2050,
  request_size_limiting: 2800,
  graphql: 2850,
  rate_limiting: 2900,
  ai_prompt_shield: 2925,
  body_validator: 2950,
  ai_request_guard: 2975,
  ai_federation: 2985,
  request_transformer: 3000,
  serverless_function: 3025,
  response_mock: 3030,
  grpc_deadline: 3050,
  request_mirror: 3075,
  response_caching: 3500,
  response_transformer: 4000,
  response_size_limiting: 4050,
  ai_response_guard: 4075,
  ai_token_metrics: 4100,
  ai_rate_limiter: 4200,
  ai_semantic_cache: 4300,
  compression: 4500,
  stdout_logging: 9000,
  http_logging: 9100,
  tcp_logging: 9125,
  udp_logging: 9130,
  kafka_logging: 9150,
  loki_logging: 9175,
  ws_logging: 9200,
  statsd_logging: 9250,
  prometheus_metrics: 9300,
  api_chargeback: 9400,
  transaction_debugger: 9500,
  load_testing: 9600,
  ws_frame_logging: 9700,
  ws_rate_limiting: 9750,
  ws_message_size_limiting: 9775,
  udp_rate_limiting: 9800,
  request_deduplication: 9850,
  spec_expose: 9900,
};

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
const GRID_TEMPLATE = "grid grid-cols-[minmax(0,2fr)_4rem_minmax(0,1.5fr)_4rem_4rem_10rem] gap-4";

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
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by plugin name, ID, or proxy ID..."
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
            title="Failed to load plugins"
            description="An error occurred while fetching plugin configurations."
          />
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
                <Button size="sm" onClick={() => navigate({ to: "/plugins/new" })}>
                  Create Plugin
                </Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !isError && configs.length > 0 && (
          <div className="divide-y divide-border/50">
            {configs.map((config) => (
              <button
                key={config.id}
                type="button"
                className={`${GRID_TEMPLATE} px-6 py-3.5 w-full text-left hover:bg-bg-card-hover transition-colors cursor-pointer`}
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
                  {config.proxy_id ?? (
                    <span className="italic">--</span>
                  )}
                </span>

                {/* Enabled */}
                <span>
                  <Badge variant={config.enabled ? "green" : "red"}>
                    {config.enabled ? "Yes" : "No"}
                  </Badge>
                </span>

                {/* Priority — treat null the same as absent so rows without an
                    override never render an empty red pill. */}
                <span>
                  {config.priority_override != null ? (
                    <span className="inline-block text-sm font-bold text-danger border border-danger/40 bg-danger/10 rounded px-1.5 py-0.5">
                      {config.priority_override}
                    </span>
                  ) : (
                    <span className="text-sm text-text-muted">
                      {DEFAULT_PLUGIN_PRIORITY[config.plugin_name] ?? "\u2014"}
                    </span>
                  )}
                </span>

                {/* Created at */}
                <span className="text-sm text-text-muted whitespace-nowrap">
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
          offset={pagination.offset}
          limit={pagination.limit}
          total={total}
          onChange={pagination.setParams}
        />
      )}
    </div>
  );
}
