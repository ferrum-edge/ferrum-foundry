/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – API spec import & management page                 */
/* ------------------------------------------------------------------ */

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { SearchBar } from "@/components/shared/SearchBar";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useApiSpecs,
  useAllApiSpecs,
  useImportApiSpec,
  useUpdateApiSpec,
  useDeleteApiSpec,
} from "@/hooks/useApiSpecs";
import * as apiSpecsApi from "@/api/apiSpecs";
import type { ApiSpecSummary } from "@/api/apiSpecs";
import { usePaginationParams } from "@/hooks/usePagination";
import { filterAndPage } from "@/lib/collectionSearch";
import { useNamespace } from "@/stores/namespace";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const IMPORT_TEMPLATE = `openapi: 3.1.0
info:
  title: My API
  version: 1.0.0
x-ferrum-proxy:
  listen_path: /my-api
  backend_scheme: https
  backend_host: api.internal.example.com
  backend_port: 443
paths:
  /items:
    get:
      responses:
        "200":
          description: OK
`;

export default function ApiSpecsPage() {
  const { toast } = useToast();
  const { scope } = useNamespace();
  const [search, setSearch] = useState("");
  const pagination = usePaginationParams();
  const searching = search.trim().length > 0;
  const pageQuery = useApiSpecs(pagination.paginationParams, !searching);
  const allQuery = useAllApiSpecs(searching);
  const importSpec = useImportApiSpec();
  const updateSpec = useUpdateApiSpec();
  const deleteSpec = useDeleteApiSpec();

  const [importOpen, setImportOpen] = useState(false);
  const [importDoc, setImportDoc] = useState("");
  const [replaceTarget, setReplaceTarget] = useState<ApiSpecSummary | null>(null);
  const [viewTarget, setViewTarget] = useState<ApiSpecSummary | null>(null);
  const [viewDoc, setViewDoc] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<ApiSpecSummary | null>(null);

  const searchPage = useMemo(
    () =>
      filterAndPage(
        allQuery.data ?? [],
        search,
        (spec, query) =>
          (spec.title ?? "").toLowerCase().includes(query) ||
          spec.id.toLowerCase().includes(query) ||
          spec.proxy_id.toLowerCase().includes(query) ||
          spec.tags.some((tag) => tag.toLowerCase().includes(query)),
        pagination.offset,
        pagination.limit,
      ),
    [allQuery.data, pagination.limit, pagination.offset, search],
  );
  const specs = searching ? searchPage.items : (pageQuery.data?.items ?? []);
  const total = searching ? searchPage.total : (pageQuery.data?.total ?? 0);
  const isLoading = searching ? allQuery.isLoading : pageQuery.isLoading;
  const isError = searching ? allQuery.isError : pageQuery.isError;

  const handleImport = async () => {
    if (!importDoc.trim()) {
      toast("error", "Paste an OpenAPI document first");
      return;
    }
    try {
      if (replaceTarget) {
        await updateSpec.mutateAsync({ id: replaceTarget.id, document: importDoc });
        toast("success", `Spec ${replaceTarget.title ?? replaceTarget.id} replaced`);
      } else {
        const created = await importSpec.mutateAsync(importDoc);
        toast("success", `Spec imported — proxy ${created.proxy_id} created`);
      }
      setImportOpen(false);
      setImportDoc("");
      setReplaceTarget(null);
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Spec import failed"));
    }
  };

  const openView = async (spec: ApiSpecSummary) => {
    setViewTarget(spec);
    setViewDoc("Loading…");
    try {
      const doc = await apiSpecsApi.getDocument(scope, spec.id);
      setViewDoc(doc);
    } catch (err) {
      setViewDoc(await getApiErrorMessage(err, "Failed to load document"));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">API Specs</h1>
          <p className="text-text-muted text-sm mt-1">
            Import OpenAPI documents to declaratively create proxies, upstreams,
            and plugins. Replacing a spec re-syncs its owned resources; deleting
            it cascades.
          </p>
        </div>
        <Button
          onClick={() => {
            setReplaceTarget(null);
            setImportDoc(IMPORT_TEMPLATE);
            setImportOpen(true);
          }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Import Spec
        </Button>
      </div>

      <SearchBar
        value={search}
        onChange={(value) => {
          setSearch(value);
          pagination.setParams({ offset: 0, limit: pagination.limit });
        }}
        placeholder="Search by title, ID, proxy, or tag..."
        className="max-w-md"
      />

      <Card className="overflow-hidden p-0">
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {!isLoading && isError && (
          <EmptyState
            title="API specs unavailable"
            description="The spec-import API requires database or control-plane mode."
          />
        )}
        {!isLoading && !isError && specs.length === 0 && (
          <EmptyState
            title={search ? "No matching specs" : "No API specs yet"}
            description={
              search
                ? "Try adjusting your search terms."
                : "Import an OpenAPI document with an x-ferrum-proxy extension to create a spec-managed proxy."
            }
          />
        )}
        {!isLoading &&
          specs.map((spec) => (
            <div
              key={spec.id}
              className="px-6 py-4 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">
                    {spec.title ?? spec.id}
                  </span>
                  {spec.info_version && <Badge variant="blue">v{spec.info_version}</Badge>}
                  <Badge variant="default">OpenAPI {spec.spec_version}</Badge>
                  <Badge variant="orange">{spec.operation_count} ops</Badge>
                  {spec.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag} variant="purple">{tag}</Badge>
                  ))}
                </div>
                <p
                  className="text-xs text-text-muted mt-1 font-mono truncate"
                  title={`proxy: ${spec.proxy_id} · ${formatBytes(spec.uncompressed_size)} · updated ${formatDate(spec.updated_at)}`}
                >
                  proxy: {spec.proxy_id} · {formatBytes(spec.uncompressed_size)} ·
                  updated {formatDate(spec.updated_at)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="secondary" size="sm" onClick={() => void openView(spec)}>
                  View
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setReplaceTarget(spec);
                    setImportDoc("Loading current document…");
                    setImportOpen(true);
                    try {
                      setImportDoc(await apiSpecsApi.getDocument(scope, spec.id));
                    } catch {
                      setImportDoc("");
                    }
                  }}
                >
                  Replace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(spec)}
                  aria-label={`Delete spec ${spec.title ?? spec.id}`}
                  title="Delete spec"
                >
                  <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
      </Card>

      {total > 0 && (
        <PaginationControls
          offset={pagination.offset}
          limit={pagination.limit}
          total={total}
          onChange={pagination.setParams}
        />
      )}

      {/* Import / replace dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>
            {replaceTarget
              ? `Replace ${replaceTarget.title ?? replaceTarget.id}`
              : "Import OpenAPI Spec"}
          </DialogTitle>
          <div className="space-y-4 mt-4">
            <p className="text-xs text-text-muted">
              YAML or JSON. The document must carry an{" "}
              <code className="font-mono">x-ferrum-proxy</code> extension;{" "}
              <code className="font-mono">x-ferrum-upstream</code>,{" "}
              <code className="font-mono">x-ferrum-plugins</code>, and{" "}
              <code className="font-mono">x-ferrum-validate</code> are optional.
            </p>
            <textarea
              value={importDoc}
              onChange={(e) => setImportDoc(e.target.value)}
              rows={18}
              className="w-full bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setImportOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                loading={importSpec.isPending || updateSpec.isPending}
              >
                {replaceTarget ? "Replace Spec" : "Import Spec"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewTarget} onOpenChange={(open) => !open && setViewTarget(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>{viewTarget?.title ?? viewTarget?.id ?? "Spec"}</DialogTitle>
          <pre className="mt-4 text-xs font-mono text-text-secondary bg-code-bg rounded-lg p-4 overflow-x-auto whitespace-pre-wrap max-h-[60vh]">
            {viewDoc}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete spec ${deleteTarget?.title ?? deleteTarget?.id}?`}
        description="This cascades: the spec's proxy, ALL of that proxy's plugins, and any spec-owned upstream are deleted."
        confirmLabel="Delete Spec"
        loading={deleteSpec.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteSpec.mutateAsync(deleteTarget.id);
            toast("success", "Spec and owned resources deleted");
          } catch (err) {
            toast("error", await getApiErrorMessage(err, "Delete failed"));
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}
