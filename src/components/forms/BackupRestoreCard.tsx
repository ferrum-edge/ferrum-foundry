/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configuration backup & restore card               */
/* ------------------------------------------------------------------ */

import { useReducer, useRef, useState } from "react";
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
import { useCapabilities } from "@/stores/capabilities";
import { CapabilityNotice, WriteAction } from "@/components/shared/CapabilityGate";
import {
  getRestoreApiSpecConfirmation,
  getRestoreFailure,
  getRestoreCommitted,
  type RestoreFailure,
} from "@/api/ops";
import { classifyUnobservedOutcome, type UnobservedOutcome } from "@/api/mutationOutcome";
import {
  beginWrite,
  getOutcomeLatches,
  isWriteInFlight,
  latchKeys,
  latchOutcome,
  releaseOutcomeLatch,
  useOutcomeLatches,
  useWritesInFlight,
  type OutcomeLatch,
} from "@/stores/outcomeLatches";

interface PendingRestore {
  data: Record<string, unknown>;
  namespace: string;
  fileName: string;
}

/** The gateway's `409` demand for a typed confirmation, and what was typed. */
interface ApiSpecRisk {
  count: number;
  serverMessage: string;
  phrase: string;
}

/**
 * The whole restore lifecycle as one value, so the illegal combinations the
 * old flag set allowed (a dialog for one file over a risk prompt for another,
 * a failure panel beside an armed confirmation, a request running with no
 * dialog open) cannot be represented.
 *
 * - `armed`: a file is chosen; the destructive confirmation is open.
 * - `running`: exactly one restore request is in flight. `risk` is set when
 *   it is the confirmed second attempt. Nothing leaves this state except that
 *   attempt's own answer: the dialogs refuse to close and the picker is off.
 * - `riskConfirm`: the gateway demanded the typed API-spec deletion phrase.
 * - `failed`: a structured failure the operator must read before choosing a
 *   file again.
 * - `unknown`: a restore whose result Foundry never observed. The payload is
 *   retained so the operator can deliberately re-arm the same backup after
 *   reading the gateway back, but the confirmation itself is disarmed: a
 *   restore that may already have run must never be one click from running
 *   again.
 */
type RestoreFlow =
  | { kind: "idle" }
  | { kind: "armed"; pending: PendingRestore }
  | { kind: "running"; attempt: number; pending: PendingRestore; risk: ApiSpecRisk | null }
  | { kind: "riskConfirm"; pending: PendingRestore; risk: ApiSpecRisk }
  | { kind: "failed"; failure: RestoreFailure }
  | {
      kind: "unknown";
      pending: PendingRestore;
      outcome: UnobservedOutcome;
      confirmedApiSpecDeletion: boolean;
    };

/** How one restore attempt ended, as far as the flow is concerned. */
type RestoreResult =
  /** Restored, or committed (the live-apply banner reports the rest). */
  | { kind: "done" }
  | { kind: "riskRequired"; count: number; serverMessage: string }
  | { kind: "failed"; failure: RestoreFailure }
  | { kind: "unknown"; outcome: UnobservedOutcome }
  /** Any other refusal: an initial attempt stays armed; a confirmed one ends. */
  | { kind: "refused" };

type RestoreEvent =
  | { type: "select"; pending: PendingRestore }
  | { type: "start"; attempt: number }
  | { type: "phrase"; phrase: string }
  | { type: "dismiss" }
  | { type: "rearm" }
  | { type: "settled"; attempt: number; result: RestoreResult };

const IDLE_RESTORE: RestoreFlow = { kind: "idle" };

function riskConfirmationPhrase(pending: PendingRestore, risk: ApiSpecRisk): string {
  return `DELETE ${risk.count} API SPECS IN ${pending.namespace}`;
}

/** The file the destructive confirmation dialog is about, while it is open. */
function armedRestore(flow: RestoreFlow): PendingRestore | null {
  if (flow.kind === "armed") return flow.pending;
  if (flow.kind === "running" && !flow.risk) return flow.pending;
  return null;
}

/** The typed API-spec deletion prompt, while it is open. */
function riskPrompt(flow: RestoreFlow): { pending: PendingRestore; risk: ApiSpecRisk } | null {
  if (flow.kind === "riskConfirm") return { pending: flow.pending, risk: flow.risk };
  if (flow.kind === "running" && flow.risk) return { pending: flow.pending, risk: flow.risk };
  return null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled restore transition: ${JSON.stringify(value)}`);
}

function settleRestore(
  flow: Extract<RestoreFlow, { kind: "running" }>,
  result: RestoreResult,
): RestoreFlow {
  switch (result.kind) {
    case "done":
      return IDLE_RESTORE;
    case "riskRequired":
      // A confirmed attempt is never offered a third attempt automatically.
      return flow.risk
        ? IDLE_RESTORE
        : {
            kind: "riskConfirm",
            pending: flow.pending,
            risk: { count: result.count, serverMessage: result.serverMessage, phrase: "" },
          };
    case "failed":
      return { kind: "failed", failure: result.failure };
    case "unknown":
      return {
        kind: "unknown",
        pending: flow.pending,
        outcome: result.outcome,
        confirmedApiSpecDeletion: flow.risk !== null,
      };
    case "refused":
      return flow.risk ? IDLE_RESTORE : { kind: "armed", pending: flow.pending };
    default:
      return assertNever(result);
  }
}

export function restoreFlowReducer(flow: RestoreFlow, event: RestoreEvent): RestoreFlow {
  switch (event.type) {
    case "select":
      // A file chosen while a restore runs must not replace its flow.
      return flow.kind === "running" ? flow : { kind: "armed", pending: event.pending };
    case "start":
      if (flow.kind === "armed") {
        return { kind: "running", attempt: event.attempt, pending: flow.pending, risk: null };
      }
      if (
        flow.kind === "riskConfirm" &&
        flow.risk.phrase === riskConfirmationPhrase(flow.pending, flow.risk)
      ) {
        return { kind: "running", attempt: event.attempt, pending: flow.pending, risk: flow.risk };
      }
      return flow;
    case "phrase":
      return flow.kind === "riskConfirm"
        ? { ...flow, risk: { ...flow.risk, phrase: event.phrase } }
        : flow;
    case "dismiss":
      // Closing a dialog never abandons a request that is still running.
      return flow.kind === "running" ? flow : IDLE_RESTORE;
    case "rearm":
      return flow.kind === "unknown" ? { kind: "armed", pending: flow.pending } : flow;
    case "settled":
      // Only the attempt the flow is waiting on may settle it.
      return flow.kind === "running" && flow.attempt === event.attempt
        ? settleRestore(flow, event.result)
        : flow;
    default:
      return assertNever(event);
  }
}

const UNKNOWN_RESTORE_CAUSE: Record<UnobservedOutcome["reason"], string> = {
  gateway_timeout:
    "The gateway did not answer within the restore budget after Foundry finished sending the backup.",
  upstream_failure:
    "The connection to the gateway failed after Foundry finished sending the backup.",
  client_timeout: "Foundry stopped waiting for the gateway's answer.",
  transport: "The request to the gateway ended without an answer.",
};

export function BackupRestoreCard() {
  const { toast } = useToast();
  const { selectedNamespace } = useNamespace();
  const backup = useBackup();
  const restore = useRestore();
  const { capabilities } = useCapabilities();
  const canExport = capabilities.configExport;
  const canRestore = capabilities.configBackup;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [flow, dispatch] = useReducer(restoreFlowReducer, IDLE_RESTORE);
  // Each request carries the attempt it started; only that attempt's answer
  // may report or settle the flow.
  const attemptRef = useRef(0);
  // A restore this card started before it was last unmounted keeps running;
  // while it does, no other restore of the namespace may start.
  const restoreKey = latchKeys.restore(selectedNamespace);
  const restoreInFlight = useWritesInFlight().has(restoreKey);
  const running = flow.kind === "running" || restoreInFlight;
  // An unknown outcome is a module latch, so it outlives this card: leaving
  // the page and coming back must not put a restore one click away again.
  // It ends only on a deliberate re-arm or a reload.
  const storedLatch = useOutcomeLatches().get(restoreKey);
  const unknownRestore = storedLatch?.kind === "restore" ? storedLatch : null;
  // The backup itself survives only in this card's flow, never in the latch.
  const rearmable =
    flow.kind === "unknown" && flow.pending.namespace === selectedNamespace ? flow.pending : null;
  // The latch the "allow another restore" confirmation was opened for.
  const [allowRestoreTarget, setAllowRestoreTarget] = useState<OutcomeLatch | null>(null);
  const restoreBlocked = running || unknownRestore !== null;

  const handleDownload = async () => {
    if (!canExport.allowed) return;
    const namespace = selectedNamespace;
    try {
      const counts = await backup.mutateAsync({ namespace });
      toast(
        "success",
        `Backup exported for namespace "${namespace}" (${counts.proxies} proxies, ` +
          `${counts.consumers} consumers). Credentials are UNREDACTED — store securely.`,
      );
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Backup failed"));
    }
  };

  const handleFileSelected = async (file: File) => {
    if (
      !canRestore.allowed ||
      running ||
      isWriteInFlight(restoreKey) ||
      getOutcomeLatches().has(restoreKey)
    ) {
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Backup root must be an object");
      }
      dispatch({
        type: "select",
        pending: {
          data: parsed as Record<string, unknown>,
          namespace: selectedNamespace,
          fileName: file.name,
        },
      });
    } catch {
      toast("error", "Not a valid JSON backup file");
    }
  };

  /** Classify a rejected attempt, reporting it the way the old panels did. */
  const restoreRejection = async (
    error: unknown,
    pending: PendingRestore,
    confirmed: boolean,
  ): Promise<RestoreResult> => {
    if (!confirmed) {
      const conflict = getRestoreApiSpecConfirmation(error);
      if (conflict) {
        return {
          kind: "riskRequired",
          count: conflict.api_specs_at_risk,
          serverMessage: conflict.error,
        };
      }
    }
    const committed = getRestoreCommitted(error);
    if (committed) {
      toast("warning", `Restore committed in namespace "${pending.namespace}". ${committed.cursor
        ? `See the live-apply banner for cursor ${committed.cursor} and runtime status.`
        : "No valid apply cursor was provided; verify the live gateway configuration before another restore."}`);
      return { kind: "done" };
    }
    const failure = getRestoreFailure(error);
    if (failure) return { kind: "failed", failure };
    const unknown = classifyUnobservedOutcome(error);
    if (unknown) return { kind: "unknown", outcome: unknown };
    toast(
      "error",
      await getApiErrorMessage(error, confirmed ? "Confirmed restore failed" : "Restore failed"),
    );
    return { kind: "refused" };
  };

  const runRestore = async () => {
    let pending: PendingRestore;
    let confirmed: boolean;
    if (flow.kind === "armed") {
      pending = flow.pending;
      confirmed = false;
    } else if (
      flow.kind === "riskConfirm" &&
      flow.risk.phrase === riskConfirmationPhrase(flow.pending, flow.risk)
    ) {
      pending = flow.pending;
      confirmed = true;
    } else {
      return;
    }
    const inFlightKey = latchKeys.restore(pending.namespace);
    if (isWriteInFlight(inFlightKey) || getOutcomeLatches().has(inFlightKey)) return;
    const attempt = ++attemptRef.current;
    dispatch({ type: "start", attempt });
    const release = beginWrite(inFlightKey);
    let result: RestoreResult;
    try {
      const restored = await restore.mutateAsync({
        data: pending.data,
        namespace: pending.namespace,
        ...(confirmed && { confirmApiSpecDeletion: true }),
      });
      if (attempt !== attemptRef.current) return;
      const counts = restored.restored;
      toast(
        "success",
        `Restored ${counts.proxies} proxies, ${counts.consumers} consumers, ${counts.plugin_configs} plugins, ${counts.upstreams} upstreams, ${counts.api_specs ?? 0} API specs, and ${counts.gateway_trust_bundles ?? 0} trust bundles.`,
      );
      result = { kind: "done" };
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      try {
        result = await restoreRejection(err, pending, confirmed);
      } catch {
        // An answer Foundry cannot even classify says nothing about what ran:
        // report it as unknown rather than leaving the flow running.
        result = {
          kind: "unknown",
          outcome: { reason: "transport", detail: "Foundry could not read the gateway's answer." },
        };
      }
      // Installed by this continuation even if the card has unmounted, and
      // before the write is released, so the namespace is never briefly
      // neither running nor latched.
      if (result.kind === "unknown") {
        latchOutcome({
          kind: "restore",
          namespace: pending.namespace,
          fileName: pending.fileName,
          outcome: result.outcome,
          confirmedApiSpecDeletion: confirmed,
        });
      }
    } finally {
      release();
    }
    dispatch({ type: "settled", attempt, result });
  };

  const armedPending = armedRestore(flow);
  const riskDialog = riskPrompt(flow);
  const expectedPhrase = riskDialog
    ? riskConfirmationPhrase(riskDialog.pending, riskDialog.risk)
    : "";

  return (
    <Card>
      <div className="space-y-4">
        <p className="text-text-muted text-sm">
          Export the full configuration of namespace{" "}
          <span className="text-text-primary font-medium">{selectedNamespace}</span>{" "}
          (proxies, consumers with unredacted credentials, plugins, upstreams,
          API specs, trust bundles) or restore from a previous export.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          {/* Each button carries its own reason: export and restore are
              separate capabilities and can be denied for different causes. */}
          <WriteAction verdict={canExport} align="start">
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
          </WriteAction>
          <WriteAction verdict={canRestore} align="start">
            <Button
              variant="secondary"
              // A file chosen mid-restore would otherwise open a second flow
              // that the running attempt's answer then lands in; after an
              // unknown outcome, only a deliberate re-arm allows another.
              disabled={restoreBlocked}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Restore From File…
            </Button>
          </WriteAction>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            disabled={restoreBlocked}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
              e.target.value = "";
            }}
          />
        </div>
        {restoreInFlight && flow.kind !== "running" && (
          <p role="status" className="text-xs text-text-muted">
            A restore of namespace &quot;{selectedNamespace}&quot; started earlier is still
            running. Another restore can be chosen once its answer arrives.
          </p>
        )}
        {/* The full explanation for whichever denial is the more fundamental. */}
        <CapabilityNotice verdict={canExport.allowed ? canRestore : canExport} />
        {flow.kind === "failed" && (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/5 p-4 space-y-3"
          >
            <div>
              <p className="text-sm font-semibold text-danger">
                {flow.failure.rollback === "incomplete" ||
                flow.failure.rollback === "unknown_outcome"
                  ? "Restore failed — manual recovery required"
                  : flow.failure.failure_class === "data_integrity"
                    ? "Restore blocked by a data-integrity failure"
                    : flow.failure.failure_class === "connectivity"
                      ? "Restore blocked by a connectivity failure"
                      : "Restore could not complete; review the recovery details"}
              </p>
              <p className="text-sm text-text-secondary mt-1">{flow.failure.error}</p>
            </div>
            {flow.failure.rollback && (
              <p className="text-sm text-text-secondary">
                Rollback outcome: {" "}
                <span className="font-mono text-text-primary">{flow.failure.rollback}</span>
              </p>
            )}
            {(flow.failure.restore_errors?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-secondary">Restore errors</p>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1 mt-1">
                  {flow.failure.restore_errors?.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
            {(flow.failure.rollback_errors?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-secondary">Rollback errors</p>
                <ul className="list-disc pl-5 text-xs text-text-muted space-y-1 mt-1">
                  {flow.failure.rollback_errors?.map((entry, index) => (
                    <li key={`${entry}-${index}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
            {flow.failure.api_specs_not_restored !== undefined && (
              <p className="text-sm text-warning">
                {flow.failure.api_specs_not_restored} API specs may still be missing.
              </p>
            )}
            {flow.failure.api_specs_note && (
              <p className="text-xs text-text-secondary">{flow.failure.api_specs_note}</p>
            )}
            <p className="text-xs text-text-muted">
              The failed backup was cleared. Review the gateway state and recovery details before
              deliberately selecting a file again.
            </p>
            <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "dismiss" })}>
              Dismiss
            </Button>
          </div>
        )}
        {unknownRestore && (
          <div
            role="alert"
            className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-3"
          >
            <div>
              <p className="text-sm font-semibold text-warning">
                Restore outcome unknown — verify the gateway before retrying
              </p>
              <p className="text-sm text-text-secondary mt-1">
                {UNKNOWN_RESTORE_CAUSE[unknownRestore.outcome.reason]} The restore of
                namespace &quot;{unknownRestore.namespace}&quot; from{" "}
                {unknownRestore.fileName} may already have run, in full or in
                part. Foundry cannot tell: the gateway offers no restore operation id
                to read back.
              </p>
            </div>
            {unknownRestore.outcome.detail && (
              <p className="text-sm text-text-secondary">{unknownRestore.outcome.detail}</p>
            )}
            {unknownRestore.confirmedApiSpecDeletion && (
              <p className="text-sm text-text-secondary">
                This attempt already carried the API-spec deletion confirmation.
              </p>
            )}
            <p className="text-xs text-text-muted">
              The confirmation was cleared and cached reads were refreshed. Inspect the
              live configuration of the namespace before deciding; restoring again
              replaces it a second time. Re-arm only once you have read the gateway
              back.
            </p>
            <div className="flex flex-wrap gap-3">
              {rearmable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={running}
                  onClick={() => {
                    if (isWriteInFlight(restoreKey)) return;
                    // The destructive confirmation for the same backup opens next,
                    // but only if this is still the outcome the panel shows.
                    if (releaseOutcomeLatch(restoreKey, unknownRestore)) dispatch({ type: "rearm" });
                  }}
                >
                  Re-arm this restore
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={running}
                  onClick={() => setAllowRestoreTarget(unknownRestore)}
                >
                  Allow another restore
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* After a remount the backup is gone, so re-arming only allows a new file. */}
      <ConfirmDialog
        open={allowRestoreTarget !== null && unknownRestore !== null}
        onOpenChange={(open) => !open && setAllowRestoreTarget(null)}
        title="Allow another restore?"
        description={`The earlier restore of namespace "${unknownRestore?.namespace ?? selectedNamespace}" from "${unknownRestore?.fileName ?? "the backup"}" may already have run. Confirm only after reading the namespace's live configuration back from the gateway; you then choose a backup file again.`}
        confirmLabel="I've checked — allow a restore"
        variant="primary"
        onConfirm={() => {
          if (!allowRestoreTarget || isWriteInFlight(restoreKey)) return;
          setAllowRestoreTarget(null);
          if (releaseOutcomeLatch(restoreKey, allowRestoreTarget)) dispatch({ type: "dismiss" });
        }}
      />

      <ConfirmDialog
        open={armedPending !== null}
        onOpenChange={(open) => !open && dispatch({ type: "dismiss" })}
        title="Restore configuration?"
        description={`This is a DESTRUCTIVE full replacement of namespace "${armedPending?.namespace ?? selectedNamespace}" using "${armedPending?.fileName ?? "the selected file"}": all current proxies, consumers, plugins, upstreams, and API specs are replaced by the pinned backup contents.`}
        confirmLabel="Restore"
        loading={running}
        onConfirm={() => void runRestore()}
      />

      <Dialog
        open={riskDialog !== null}
        onOpenChange={(open) => !open && dispatch({ type: "dismiss" })}
      >
        <DialogContent busy={running}>
          <DialogTitle>Confirm API spec deletion</DialogTitle>
          <DialogDescription className="mt-2">
            The gateway reports that restoring {riskDialog?.pending.fileName} into
            namespace &quot;{riskDialog?.pending.namespace}&quot; will delete {" "}
            <strong className="text-danger">
              {riskDialog?.risk.count ?? 0} existing API specs
            </strong>
            . {riskDialog?.risk.serverMessage}
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <Input
              label="Type the exact phrase to continue"
              value={riskDialog?.risk.phrase ?? ""}
              onChange={(event) => dispatch({ type: "phrase", phrase: event.target.value })}
              disabled={running}
              placeholder={expectedPhrase}
              autoComplete="off"
              spellCheck={false}
            />
            <code className="block rounded bg-code-bg p-3 text-xs text-text-secondary break-all">
              {expectedPhrase}
            </code>
            <div className="flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => dispatch({ type: "dismiss" })}
                disabled={running}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={running}
                disabled={riskDialog?.risk.phrase !== expectedPhrase}
                onClick={() => void runRestore()}
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
