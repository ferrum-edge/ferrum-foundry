/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – diagnostic reference lookup                       */
/* ------------------------------------------------------------------ */

import { isHTTPError } from "ky";
import { api, scoped, SILENT_ERRORS, type NamespaceScope } from "./client";

/** The reference format Edge stamps in `X-Ferrum-Diagnostic-Ref`. */
export const DIAGNOSTIC_REF_PATTERN = /^(?:fd1_[0-9a-f]{32}|fd2_[0-9a-f]{8}_[0-9a-f]{32})$/;

export interface DiagnosticAttempt {
  attempt: number;
  backend_dispatch: string;
  status?: number;
  error_class?: string;
  tls?: { failure: string; reason?: string };
}

/** The BFF's reviewed projection of Edge's `DiagnosticRefLookup`. */
export interface DiagnosticLookup {
  schema_version: string;
  ref: string;
  replica_id?: string;
  namespace: string;
  created_at: string;
  expires_at: string;
  protocol: string;
  status: number;
  gateway_error: string | null;
  detail_available: boolean;
  detail?: {
    error_class: string | null;
    body_error_class: string | null;
    rejection_phase: string | null;
    route_timeout_phase: string | null;
    backend_dispatch: string;
    proxy_id: string | null;
    /** `scheme://host:port` only. */
    backend_target: string | null;
    duration_bucket: string;
    rejection?: { source: string; phase: string; plugin?: string };
    attempts: DiagnosticAttempt[];
    attempts_omitted?: number;
  };
}

/** A refused or failed lookup, with the BFF's fixed message and code. */
export class DiagnosticLookupError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly ownerReplica: string | null,
  ) {
    super(message);
    this.name = "DiagnosticLookupError";
  }
}

/** Whether this session's role may resolve diagnostic references. */
export async function getDiagnosticsPermission(): Promise<boolean> {
  const body = await api
    .get("api/diagnostics/config", { retry: 0, context: { [SILENT_ERRORS]: true } })
    .json<{ lookupPermitted?: unknown }>();
  return body.lookupPermitted === true;
}

export async function lookupDiagnosticRef(
  scope: NamespaceScope,
  ref: string,
  signal?: AbortSignal,
): Promise<DiagnosticLookup> {
  try {
    return await api
      // In a header, never the URL: a request target is what proxies log.
      .get("api/diagnostics/lookup", scoped(scope, {
        headers: { "X-Ferrum-Diagnostic-Ref": ref },
        retry: 0,
        signal,
        context: { [SILENT_ERRORS]: true },
      }))
      .json<DiagnosticLookup>();
  } catch (error) {
    if (!isHTTPError(error)) {
      throw new DiagnosticLookupError("The diagnostic lookup could not reach Foundry.", 0, null, null);
    }
    const data = error.data as { error?: unknown; code?: unknown; owner_replica?: unknown } | undefined;
    const message = typeof data?.error === "string" && data.error.length <= 256
      ? data.error
      : `The diagnostic lookup failed (HTTP ${error.response.status}).`;
    throw new DiagnosticLookupError(
      message,
      error.response.status,
      typeof data?.code === "string" ? data.code : null,
      typeof data?.owner_replica === "string" ? data.owner_replica : null,
    );
  }
}
