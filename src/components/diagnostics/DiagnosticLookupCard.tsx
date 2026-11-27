/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – diagnostic reference lookup card (ADR 0001)       */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { HealthFields } from "@/components/health/HealthSection";
import {
  DIAGNOSTIC_REF_PATTERN,
  DiagnosticLookupError,
  getDiagnosticsPermission,
  lookupDiagnosticRef,
  type DiagnosticLookup,
} from "@/api/diagnostics";
import { useAuth } from "@/stores/auth";
import { useNamespace } from "@/stores/namespace";

/**
 * Resolves an `X-Ferrum-Diagnostic-Ref` from a gateway error response through
 * the BFF's authenticated lookup. Shown only to a role the deployment lists in
 * `FERRUM_DIAGNOSTICS_ROLES`; the BFF refuses every other role whatever this
 * renders. The lookup is bound to the tab's active namespace, the one the
 * reference must have been minted in.
 */
export function DiagnosticLookupCard() {
  const { principal } = useAuth();
  const { scope } = useNamespace();
  const permission = useQuery({
    queryKey: ["diagnosticsPermission", principal?.subject ?? null, principal?.role ?? null],
    queryFn: getDiagnosticsPermission,
    enabled: principal !== null,
    staleTime: Infinity,
    retry: false,
  });
  const [ref, setRef] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const lookup = useMutation({
    mutationFn: (value: string) => lookupDiagnosticRef(scope, value),
  });

  if (permission.data !== true) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = ref.trim();
    if (!DIAGNOSTIC_REF_PATTERN.test(value)) {
      setInputError("Paste the X-Ferrum-Diagnostic-Ref value: fd1_ and 32 hex digits, or fd2_<replica>_<32 hex>.");
      return;
    }
    setInputError(null);
    lookup.mutate(value);
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary mb-1">Diagnostic reference lookup</h2>
      <p className="text-xs text-text-muted mb-3">
        Resolves a gateway error&apos;s <span className="font-mono">X-Ferrum-Diagnostic-Ref</span> in namespace{" "}
        <span className="font-mono">{scope.namespace}</span>. A reference lives only in the memory of the
        gateway process that answered, for a limited time.
      </p>
      <form className="flex flex-col gap-2 sm:flex-row sm:items-start" onSubmit={submit} noValidate>
        <div className="flex-1 min-w-0">
          <Input
            label="Diagnostic reference"
            value={ref}
            onChange={(event) => {
              setRef(event.target.value);
              setInputError(null);
            }}
            placeholder="fd1_…"
            spellCheck={false}
            autoComplete="off"
            error={inputError ?? undefined}
          />
        </div>
        <Button type="submit" className="sm:mt-6" loading={lookup.isPending}>
          Look up
        </Button>
      </form>
      {lookup.isError && <LookupFailure error={lookup.error} />}
      {lookup.data && <LookupResult result={lookup.data} />}
    </Card>
  );
}

function LookupFailure({ error }: { error: unknown }) {
  const failure = error instanceof DiagnosticLookupError ? error : null;
  return (
    <div className="mt-3 text-sm" role="alert">
      <p className={failure?.status === 404 ? "text-text-secondary" : "text-warning"}>
        {failure?.message ?? "The diagnostic lookup failed."}
      </p>
      {failure?.ownerReplica && (
        <p className="text-xs text-text-muted mt-1">
          Gateway replica <span className="font-mono">{failure.ownerReplica}</span> minted this reference; query
          that replica&apos;s admin API.
        </p>
      )}
    </div>
  );
}

function LookupResult({ result }: { result: DiagnosticLookup }) {
  const detail = result.detail;
  return (
    <div className="mt-4 space-y-3" aria-label="Diagnostic reference detail">
      <HealthFields
        fields={[
          ["Status", result.status],
          ["Gateway error", result.gateway_error],
          ["Protocol", result.protocol],
          ["Namespace", result.namespace],
          ["Created", result.created_at],
          ["Expires", result.expires_at],
          ...(result.replica_id ? [["Replica", result.replica_id] as const] : []),
          ["Detail available", result.detail_available],
        ]}
      />
      {detail && (
        <>
          <h3 className="text-xs font-semibold text-text-secondary">Detail</h3>
          <HealthFields
            fields={[
              ["Proxy", detail.proxy_id],
              ["Backend target", detail.backend_target],
              ["Backend dispatch", detail.backend_dispatch],
              ["Error class", detail.error_class],
              ["Body error class", detail.body_error_class],
              ["Rejection phase", detail.rejection_phase],
              ["Route timeout phase", detail.route_timeout_phase],
              ["Duration", detail.duration_bucket],
              ...(detail.rejection
                ? [["Rejected by", `${detail.rejection.source} · ${detail.rejection.phase}${detail.rejection.plugin ? ` · ${detail.rejection.plugin}` : ""}`] as const]
                : []),
            ]}
          />
          {detail.attempts.length > 0 && (
            <ol className="text-xs text-text-secondary space-y-1 list-decimal pl-5">
              {detail.attempts.map((attempt) => (
                <li key={attempt.attempt}>
                  {attempt.backend_dispatch.replaceAll("_", " ")}
                  {attempt.status !== undefined ? ` · HTTP ${attempt.status}` : ""}
                  {attempt.error_class ? ` · ${attempt.error_class}` : ""}
                  {attempt.tls ? ` · TLS ${attempt.tls.failure}${attempt.tls.reason ? ` (${attempt.tls.reason})` : ""}` : ""}
                </li>
              ))}
            </ol>
          )}
          {detail.attempts_omitted ? (
            <p className="text-xs text-text-muted">{detail.attempts_omitted} more attempts not shown.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
