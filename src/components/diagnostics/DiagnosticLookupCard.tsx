/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – diagnostic reference lookup card (ADR 0001)       */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState, type FormEvent } from "react";
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
import type { NamespaceScope } from "@/api/client";
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
  if (permission.data !== true) return null;
  // Keyed by namespace: a switch drops the input, any answer on screen, and
  // a lookup still in flight, which belong to the namespace it was sent in.
  return <LookupForm key={scope.namespace} scope={scope} />;
}

function LookupForm({ scope }: { scope: NamespaceScope }) {
  const [ref, setRef] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // One controller per lookup: editing the reference, a new lookup, or the
  // form unmounting (a namespace switch, leaving the page) cancels the request
  // in flight, so the BFF releases its slot instead of waiting it out.
  const inFlight = useRef<AbortController | null>(null);
  const lookup = useMutation({
    mutationFn: (value: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      return lookupDiagnosticRef(scope, value, controller.signal);
    },
  });
  const { reset } = lookup;
  useEffect(() => () => inFlight.current?.abort(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = ref.trim();
    if (!DIAGNOSTIC_REF_PATTERN.test(value)) {
      setInputError("Paste the X-Ferrum-Diagnostic-Ref value: fd1_ and 32 hex digits, or fd2_<replica>_<32 hex>.");
      return;
    }
    setInputError(null);
    reset();
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
              // A result describes the reference it was looked up for; once
              // the field changes it would read as the new one's.
              inFlight.current?.abort();
              reset();
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
          The reference names gateway replica <span className="font-mono">{failure.ownerReplica}</span>. Only that
          replica&apos;s admin API could resolve it, if it still holds it.
        </p>
      )}
    </div>
  );
}

function LookupResult({ result }: { result: DiagnosticLookup }) {
  const detail = result.detail;
  return (
    <div className="mt-4 space-y-3" aria-label="Diagnostic reference detail">
      <p className="text-xs text-text-secondary">
        Reference <span className="font-mono text-text-primary break-all">{result.ref}</span>
      </p>
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
