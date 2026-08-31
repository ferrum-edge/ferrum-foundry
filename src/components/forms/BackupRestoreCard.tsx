/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configuration backup & restore card               */
/* ------------------------------------------------------------------ */

import { useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import { useBackup, useRestore } from "@/hooks/useOps";
import { useNamespace } from "@/stores/namespace";
import {
  getRestoreApiSpecConfirmation,
  getRestoreFailure,
  type RestoreFailure,
} from "@/api/ops";

interface PendingRestore {
  data: Record<string, unknown>;
  namespace: string;
  fileName: string;
}

interface ApiSpecRisk {
  pending: PendingRestore;
  count: number;
  serverMessage: string;
}

export function BackupRestoreCard() {
  const { toast } = useToast();
  const { selectedNamespace } = useNamespace();
  const backup = useBackup();
  const restore = useRestore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [apiSpecRisk, setApiSpecRisk] = useState<ApiSpecRisk | null>(null);
  const [riskPhrase, setRiskPhrase] = useState("");
  const [restoreFailure, setRestoreFailure] = useState<RestoreFailure | null>(null);

  const handleDownload = async () => {
    try {
      const data = await backup.mutateAsync(undefined);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ferrum-backup-${selectedNamespace}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(
        "success",
        `Backup exported (${data.counts.proxies} proxies, ${data.counts.consumers} consumers). Credentials are UNREDACTED — store securely.`,
      );
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Backup failed"));
    }
  };

  const handleFileSelected = async (file: File) => {
    try {
      setRestoreFailure(null);
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Backup root must be an object");
      }
      setPendingRestore({
        data: parsed as Record<string, unknown>,
        namespace: selectedNamespace,
        fileName: file.name,
      });
    } catch {
      toast("error", "Not a valid JSON backup file");
    }
  };

  const clearRestore = () => {
    setPendingRestore(null);
    setApiSpecRisk(null);
    setRiskPhrase("");
  };

  const showRestoreFailure = (error: unknown): boolean => {
    const failure = getRestoreFailure(error);
    if (!failure) return false;
    clearRestore();
    setRestoreFailure(failure);
    return true;
  };

  const showRestoreSuccess = (result: Awaited<ReturnType<typeof restore.mutateAsync>>) => {
    const counts = result.restored;
    toast(
      "success",
      `Restored ${counts.proxies} proxies, ${counts.consumers} consumers, ${counts.plugin_configs} plugins, ${counts.upstreams} upstreams, ${counts.api_specs ?? 0} API specs, and ${counts.gateway_trust_bundles ?? 0} trust bundles.`,
    );
    setRestoreFailure(null);
    clearRestore();
  };

  const runInitialRestore = async () => {
    if (!pendingRestore) return;
    try {
      const result = await restore.mutateAsync({
        data: pendingRestore.data,
        namespace: pendingRestore.namespace,
      });
      showRestoreSuccess(result);
    } catch (err) {
      const conflict = getRestoreApiSpecConfirmation(err);
      if (conflict) {
        setApiSpecRisk({
          pending: pendingRestore,
          count: conflict.api_specs_at_risk,
          serverMessage: conflict.error,
        });
        setRiskPhrase("");
        return;
      }
      if (showRestoreFailure(err)) return;
      toast("error", await getApiErrorMessage(err, "Restore failed"));
    }
  };

  const riskConfirmationPhrase = apiSpecRisk
    ? `DELETE ${apiSpecRisk.count} API SPECS IN ${apiSpecRisk.pending.namespace}`
    : "";

  const runConfirmedRestore = async () => {
    if (!apiSpecRisk || riskPhrase !== riskConfirmationPhrase) return;
    try {
      const result = await restore.mutateAsync({
        data: apiSpecRisk.pending.data,
        namespace: apiSpecRisk.pending.namespace,
        confirmApiSpecDeletion: true,
      });
      showRestoreSuccess(result);
    } catch (err) {
      // A confirmed restore is never offered a third attempt automatically.
      if (showRestoreFailure(err)) return;
      toast("error", await getApiErrorMessage(err, "Confirmed restore failed"));
      clearRestore();
    }
  };

  return (
    <Card>
      <div className="space-y-4">
        <p className="text-text-muted text-sm">
          Export the full configuration of namespace{" "}
          <span className="text-text-primary font-medium">{selectedNamespace}</span>{" "}
          (proxies, consumers with unredacted credentials, plugins, upstreams,
          API specs, trust bundles) or restore from a previous export.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            loading={backup.isPending}
            onClick={handleDownload}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download Backup
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Restore From File…
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
              e.target.value = "";
            }}
          />
        </div>
        {restoreFailure && (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/5 p-4 space-y-3"
          >
            <div>
              <p className="text-sm font-semibold text-danger">
                {restoreFailure.rollback === "incomplete" ||
                restoreFailure.rollback === "unknown_outcome"
                  ? "Restore failed — manual recovery required"
                  : restoreFailure.failure_class === "data_integrity"
                    ? "Restore blocked by a data-integrity failure"
                    : "Restore failed; review the rollback outcome"}
              </p>
              <p className="text-sm text-text-secondary mt-1">{restoreFailure.error}</p>
            </div>
            {restoreFailure.rollback && (
              <p className="text-sm text-text-secondary">
                Rollback outcome: {" "}
                <span className="font-mono text-text-primary">{restoreFailure.rollback}</span>
              </p>
            )}
            {(restoreFailure.restore_errors?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-secondary">Restore errors</p>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1 mt-1">
                  {restoreFailure.restore_errors?.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
            {(restoreFailure.rollback_errors?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-secondary">Rollback errors</p>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1 mt-1">
                  {restoreFailure.rollback_errors?.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
            {restoreFailure.api_specs_not_restored !== undefined && (
              <p className="text-sm text-warning">
                {restoreFailure.api_specs_not_restored} API specs may still be missing.
              </p>
            )}
            {restoreFailure.api_specs_note && (
              <p className="text-xs text-text-secondary">{restoreFailure.api_specs_note}</p>
            )}
            <p className="text-xs text-text-muted">
              The failed backup was cleared. Review the gateway state and recovery details before
              deliberately selecting a file again.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setRestoreFailure(null)}>
              Dismiss
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingRestore && !apiSpecRisk}
        onOpenChange={(open) => !open && clearRestore()}
        title="Restore configuration?"
        description={`This is a DESTRUCTIVE full replacement of namespace "${pendingRestore?.namespace ?? selectedNamespace}" using "${pendingRestore?.fileName ?? "the selected file"}": all current proxies, consumers, plugins, upstreams, and API specs are replaced by the pinned backup contents.`}
        confirmLabel="Restore"
        loading={restore.isPending}
        onConfirm={() => void runInitialRestore()}
      />

      <Dialog open={!!apiSpecRisk} onOpenChange={(open) => !open && clearRestore()}>
        <DialogContent>
          <DialogTitle>Confirm API spec deletion</DialogTitle>
          <DialogDescription className="mt-2">
            The gateway reports that restoring {apiSpecRisk?.pending.fileName} into
            namespace &quot;{apiSpecRisk?.pending.namespace}&quot; will delete {" "}
            <strong className="text-danger">
              {apiSpecRisk?.count ?? 0} existing API specs
            </strong>
            . {apiSpecRisk?.serverMessage}
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <Input
              label="Type the exact phrase to continue"
              value={riskPhrase}
              onChange={(event) => setRiskPhrase(event.target.value)}
              placeholder={riskConfirmationPhrase}
              autoComplete="off"
              spellCheck={false}
            />
            <code className="block rounded bg-code-bg p-3 text-xs text-text-secondary break-all">
              {riskConfirmationPhrase}
            </code>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={clearRestore} disabled={restore.isPending}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={restore.isPending}
                disabled={riskPhrase !== riskConfirmationPhrase}
                onClick={() => void runConfirmedRestore()}
              >
                Delete specs and restore
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
