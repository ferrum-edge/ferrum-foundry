/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – API spec import & management page                 */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * A list page's editor identity is the namespace alone. The import editor,
 * replace/view/delete targets, and the search box below are pending state
 * for one tenant, so the workspace is keyed on the namespace and remounts
 * on a switch rather than letting a confirmation opened under one tenant
 * act on the same spec id in another (see `src/lib/editorIdentity.ts`).
 */
export default function ApiSpecsPage() {
  const { scope } = useNamespace();
  return <ApiSpecsWorkspace key={scope.namespace} />;
}

function ApiSpecsWorkspace() {
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
  const [importLoading, setImportLoading] = useState(false);
  const importGeneration = useRef(0);
  const viewGeneration = useRef(0);
  useEffect(() => () => {
    importGeneration.current += 1;
    viewGeneration.current += 1;
  }, []);
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

  // Each opening is a new session, even when the same spec is reopened.
  const closeImport = () => {
    importGeneration.current += 1;
    setImportOpen(false);
    setImportLoading(false);
  };

  const openReplace = async (spec: ApiSpecSummary) => {
    const generation = ++importGeneration.current;
    setReplaceTarget(spec);
    setImportDoc("");
    setImportLoading(true);
    setImportOpen(true);
    try {
      const doc = await apiSpecsApi.getDocument(scope, spec.id);
      if (generation === importGeneration.current) setImportDoc(doc);
    } catch (err) {
      const message = await getApiErrorMessage(err, "Failed to load document");
      if (generation === importGeneration.current) toast("error", message);
    } finally {
      if (generation === importGeneration.current) setImportLoading(false);
    }
  };

  const handleImport = async () => {
    if (importLoading) return;
    if (!importDoc.trim()) {
      toast("error", "Paste an OpenAPI document first");
      return;
    }
    const generation = importGeneration.current;
    try {
      let message: string;
      if (replaceTarget) {
        await updateSpec.mutateAsync({ id: replaceTarget.id, document: importDoc });
        message = `Spec ${replaceTarget.title ?? replaceTarget.id} replaced`;
      } else {
        const created = await importSpec.mutateAsync(importDoc);
        message = `Spec imported — proxy ${created.proxy_id} created`;
      }
      if (generation !== importGeneration.current) return;
      toast("success", message);
      closeImport();
      setImportDoc("");
      setReplaceTarget(null);
    } catch (err) {
      const message = await getApiErrorMessage(err, "Spec import failed");
      if (generation === importGeneration.current) toast("error", message);
    }
  };

  const closeView = () => {
    viewGeneration.current += 1;
    setViewTarget(null);
  };

  const openView = async (spec: ApiSpecSummary) => {
    const generation = ++viewGeneration.current;
    setViewTarget(spec);
    setViewDoc("Loading…");
    try {
      const doc = await apiSpecsApi.getDocument(scope, spec.id);
      if (generation === viewGeneration.current) setViewDoc(doc);
    } catch (err) {
      const message = await getApiErrorMessage(err, "Failed to load document");
      if (generation === viewGeneration.current) setViewDoc(message);
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
            importGeneration.current += 1;
            setImportLoading(false);
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
            title={total > 0 ? "No results on this page" : search ? "No matching specs" : "No API specs yet"}
            description={
              total > 0
                ? "Use Go to last page below to return to the available results."
                : search
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
                  onClick={() => void openReplace(spec)}
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
      <Dialog open={importOpen} onOpenChange={(open) => !open && closeImport()}>
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
              aria-label="OpenAPI document"
              disabled={importLoading}
              placeholder={importLoading ? "Loading current document…" : "Paste an OpenAPI document"}
              value={importDoc}
              onChange={(e) => setImportDoc(e.target.value)}
              rows={18}
              className="w-full bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeImport}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={importLoading}
                loading={importSpec.isPending || updateSpec.isPending}
              >
                {replaceTarget ? "Replace Spec" : "Import Spec"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewTarget} onOpenChange={(open) => !open && closeView()}>
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
