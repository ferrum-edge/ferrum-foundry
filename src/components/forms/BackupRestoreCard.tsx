/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configuration backup & restore card               */
/* ------------------------------------------------------------------ */

import { useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import { useBackup, useRestore } from "@/hooks/useOps";
import { useNamespace } from "@/stores/namespace";

export function BackupRestoreCard() {
  const { toast } = useToast();
  const { selectedNamespace } = useNamespace();
  const backup = useBackup();
  const restore = useRestore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingRestore, setPendingRestore] = useState<Record<string, unknown> | null>(null);

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
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setPendingRestore(parsed);
    } catch {
      toast("error", "Not a valid JSON backup file");
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
      </div>

      <ConfirmDialog
        open={!!pendingRestore}
        onOpenChange={(open) => !open && setPendingRestore(null)}
        title="Restore configuration?"
        description={`This is a DESTRUCTIVE full replacement of namespace "${selectedNamespace}": all current proxies, consumers, plugins, upstreams, and API specs are replaced by the backup contents.`}
        confirmLabel="Restore"
        loading={restore.isPending}
        onConfirm={async () => {
          if (!pendingRestore) return;
          try {
            const result = await restore.mutateAsync({ data: pendingRestore });
            toast(
              "success",
              `Restored ${result.restored.proxies} proxies, ${result.restored.consumers} consumers, ${result.restored.plugin_configs} plugins, ${result.restored.upstreams} upstreams.`,
            );
            setPendingRestore(null);
          } catch (err) {
            toast("error", await getApiErrorMessage(err, "Restore failed"));
          }
        }}
      />
    </Card>
  );
}
