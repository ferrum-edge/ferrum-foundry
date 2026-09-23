/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – concurrent-edit conflict dialog                   */
/* ------------------------------------------------------------------ */

import { useMemo } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { StaleResourceDetail } from "@/api/conditionalWrite";
import { compareBaselines, formatBaselineValue } from "@/lib/resourceBaseline";

export interface StaleWriteDialogProps {
  /** The refused write, or null when there is no conflict to resolve. */
  conflict: StaleResourceDetail | null;
  /** Dismiss and go back to the untouched draft. */
  onKeepEditing: () => void;
  /**
   * Discard the local draft and reseed the editor from the gateway. The caller
   * remounts the editor, which is what makes this a deliberate restart rather
   * than a rebase of dirty fields onto newer data.
   */
  onDiscardAndReload: () => void;
}

/**
 * Shown when a full-replacement save was refused because the resource changed
 * on the gateway after this editor opened it — by Foundry's verification read,
 * or by the gateway's own `If-Match` precondition.
 *
 * Three rules this dialog exists to keep:
 *
 * 1. **The draft survives.** Nothing here edits the form. "Keep my draft" just
 *    closes the dialog and the operator is back in their unsaved changes.
 * 2. **No automatic reapplication.** There is deliberately no "save anyway"
 *    button: re-sending the same body against the newer revision is the silent
 *    overwrite the guard refused. Re-applying means editing the fields again
 *    against current content, which the operator does themselves.
 * 3. **No secrets on screen.** Values are rendered through
 *    `formatBaselineValue`, which redacts credential-shaped fields while still
 *    showing that they moved.
 */
export function StaleWriteDialog({
  conflict,
  onKeepEditing,
  onDiscardAndReload,
}: StaleWriteDialogProps) {
  const differences = useMemo(
    () =>
      conflict
        ? compareBaselines(conflict.original, conflict.current, conflict.proposed)
        : [],
    [conflict],
  );

  if (!conflict) return null;

  const conflicting = differences.filter(
    (difference) => difference.changedUpstream && difference.changedLocally,
  );
  const isDelete = conflict.operation === "delete";
  // A refused delete has no draft column: nothing about the resource was
  // going to be written, only removed.
  const columns = isDelete
    ? "grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
    : "grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onKeepEditing(); }}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>This {conflict.resource} changed after you opened it</DialogTitle>
        {isDelete ? (
          <DialogDescription className="mt-2">
            It was <strong>not</strong> deleted.{" "}
            <span className="font-mono">{conflict.id}</span> in namespace{" "}
            <span className="font-mono">{conflict.namespace}</span> was written after
            this page loaded — by another session, another tool, or another tab of
            this page. Review what it holds now before deciding to delete it.
          </DialogDescription>
        ) : (
          <DialogDescription className="mt-2">
            Your changes were <strong>not</strong> saved and nothing from this draft
            was written to the gateway.{" "}
            <span className="font-mono">{conflict.id}</span> in namespace{" "}
            <span className="font-mono">{conflict.namespace}</span> was written after
            this editor opened — by another session, another tool, or another tab of
            this page such as the upstream Targets tab. A save here replaces the
            whole {conflict.resource}, so submitting your draft would have reverted
            that change.
          </DialogDescription>
        )}

        {conflicting.length > 0 && (
          <p className="mt-3 text-sm text-warning">
            {conflicting.length} field{conflicting.length === 1 ? "" : "s"} changed
            on both sides.
          </p>
        )}

        <div className="mt-4 border border-border rounded-lg overflow-hidden">
          <div className={`grid ${columns} gap-3 px-4 py-2 bg-bg-card border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider`}>
            <span>Field</span>
            <span>When you opened it</span>
            <span>On the gateway now</span>
            {!isDelete && <span>Your draft</span>}
          </div>
          <div className="max-h-[320px] overflow-auto divide-y divide-border/50">
            {differences.length === 0 ? (
              <p className="px-4 py-4 text-sm text-text-muted">
                The change is in a field this comparison does not model. Reload to
                see the gateway&rsquo;s current configuration.
              </p>
            ) : (
              differences.map((difference) => (
                <div
                  key={difference.field}
                  className={`grid ${columns} gap-3 px-4 py-2.5 text-xs`}
                >
                  <span className="font-mono text-text-primary break-all">
                    {difference.field}
                    {difference.changedUpstream && difference.changedLocally && (
                      <Badge variant="yellow" className="ml-2">
                        both
                      </Badge>
                    )}
                  </span>
                  <span className="text-text-muted break-all whitespace-pre-wrap">
                    {formatBaselineValue(difference.field, difference.original)}
                  </span>
                  <span
                    className={`break-all whitespace-pre-wrap ${
                      difference.changedUpstream ? "text-warning" : "text-text-muted"
                    }`}
                  >
                    {formatBaselineValue(difference.field, difference.current)}
                  </span>
                  {!isDelete && (
                    <span
                      className={`break-all whitespace-pre-wrap ${
                        difference.changedLocally ? "text-orange" : "text-text-muted"
                      }`}
                    >
                      {formatBaselineValue(difference.field, difference.proposed)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {isDelete ? (
          <p className="mt-4 text-xs text-text-muted">
            Reloading shows the current configuration and discards any unsaved
            edits on this page. Delete again from there if it should still go.
          </p>
        ) : (
          <p className="mt-4 text-xs text-text-muted">
            Your draft is still on the page. Re-apply the changes you still want on
            top of the current configuration, then save again. Foundry will not
            resend this body for you.
          </p>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="danger" onClick={onDiscardAndReload}>
            {isDelete ? "Reload current version" : "Discard my draft and reload"}
          </Button>
          <Button onClick={onKeepEditing}>{isDelete ? "Close" : "Keep my draft"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
