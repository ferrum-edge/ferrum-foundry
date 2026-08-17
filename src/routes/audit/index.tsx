/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Audit log page                                    */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useAuditEvents } from "@/hooks/useOps";
import type { AuditEvent } from "@/api/ops";

const PAGE_SIZE = 50;

function outcomeBadge(outcome?: AuditEvent["outcome"]) {
  if (!outcome) return null;
  const variant =
    outcome === "success"
      ? "green"
      : outcome === "denied" || outcome === "failure"
        ? "red"
        : "yellow";
  return <Badge variant={variant}>{outcome.replace(/_/g, " ")}</Badge>;
}

function actionBadge(action: string) {
  const variant =
    action === "delete" ? "red" : action === "create" ? "green" : "blue";
  return <Badge variant={variant}>{action}</Badge>;
}

export default function AuditPage() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError } = useAuditEvents({
    ...(actor && { actor }),
    ...(action && { action }),
    ...(resourceType && { resource_type: resourceType }),
    limit: PAGE_SIZE,
    offset,
  });

  const events = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Audit Log</h1>
        <p className="text-text-muted text-sm mt-1">
          Every admin API mutation with actor, outcome, and a redacted diff.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="w-48">
          <Input label="Actor" value={actor} onChange={(e) => { setActor(e.target.value); setOffset(0); }} placeholder="JWT subject" />
        </div>
        <div className="w-44">
          <Select
            label="Action"
            value={action || "all"}
            onValueChange={(v) => { setAction(v === "all" ? "" : v); setOffset(0); }}
            options={[
              { value: "all", label: "All actions" },
              { value: "create", label: "Create" },
              { value: "update", label: "Update" },
              { value: "delete", label: "Delete" },
              { value: "backup", label: "Backup" },
              { value: "restore", label: "Restore" },
            ]}
          />
        </div>
        <div className="w-48">
          <Select
            label="Resource"
            value={resourceType || "all"}
            onValueChange={(v) => { setResourceType(v === "all" ? "" : v); setOffset(0); }}
            options={[
              { value: "all", label: "All resources" },
              { value: "proxy", label: "Proxy" },
              { value: "consumer", label: "Consumer" },
              { value: "plugin_config", label: "Plugin Config" },
              { value: "upstream", label: "Upstream" },
              { value: "api_spec", label: "API Spec" },
              { value: "gateway_trust_bundle", label: "Trust Bundle" },
            ]}
          />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {!isLoading && isError && (
          <EmptyState
            title="Audit log unavailable"
            description="Audit persistence may be disabled on this gateway."
          />
        )}
        {!isLoading && !isError && events.length === 0 && (
          <EmptyState
            title="No audit events"
            description="Admin API mutations will appear here."
          />
        )}
        {!isLoading &&
          events.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => setExpanded(expanded === event.id ? null : event.id)}
              className="w-full text-left px-6 py-3 border-b border-border/50 last:border-b-0 hover:bg-bg-card-hover transition-colors"
            >
              <div className="flex items-center gap-3 flex-wrap">
                {actionBadge(event.action)}
                <span className="text-sm text-text-primary font-medium">
                  {event.resource_type}
                </span>
                <span className="text-xs text-text-muted font-mono">{event.resource_id}</span>
                {outcomeBadge(event.outcome)}
                <span className="text-xs text-text-muted ml-auto">
                  {event.actor} · {new Date(event.ts).toLocaleString()}
                </span>
              </div>
              {expanded === event.id && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-4 text-xs text-text-muted flex-wrap">
                    <span>namespace: {event.namespace}</span>
                    {event.source_address && <span>from: {event.source_address}</span>}
                    {event.request_id && <span>request: {event.request_id}</span>}
                  </div>
                  <pre className="text-xs font-mono text-text-secondary bg-code-bg rounded-lg p-3 overflow-x-auto max-h-72">
                    {JSON.stringify(event.diff, null, 2)}
                  </pre>
                </div>
              )}
            </button>
          ))}
      </Card>

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={data.next_offset == null}
              onClick={() => setOffset(data.next_offset ?? offset)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
