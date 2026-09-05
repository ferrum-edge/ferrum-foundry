/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configured ky HTTP client                        */
/* ------------------------------------------------------------------ */

import ky from "ky";
import { serverWaitTimeout } from "../../server/waitBudget";
import type { ApiError } from "./types";
import {
  observeGatewayResponse,
  setApplyStatusFetcher,
  type ApplyStatusResponse,
} from "./gatewayMetadata";

// ── Global error handler (event-emitter style) ───────────────────

type ApiErrorHandler = (error: ApiError) => void;

let errorHandler: ApiErrorHandler | undefined;

/**
 * Register a handler that will be called on every non-2xx API response.
 * Only one handler is active at a time (last-write wins).
 */
export function setApiErrorHandler(handler?: ApiErrorHandler): void {
  errorHandler = handler;
}

/**
 * Dispatch an API error to the registered handler (if any).
 */
export function onApiError(error: ApiError): void {
  errorHandler?.(error);
}

export function extractApiErrorDetail(body: string): string {
  if (!body.trim()) return "";

  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const detail = record.error ?? record.message ?? record.detail;
      if (typeof detail === "string") return detail;
    }
  } catch {
    // Plain text responses are fine; fall through to the raw body.
  }

  return body;
}

/**
 * Pull the server's error detail out of ky's pre-parsed `error.data`.
 *
 * ky v2 parses the failing response body into `data` and, in doing so,
 * *consumes the response* — `error.response.clone()` throws "body is already
 * used" from then on. `data` is a parsed object for JSON content types, a
 * plain string otherwise, and `undefined` when the body was empty or failed
 * to parse.
 */
export function extractApiErrorData(data: unknown): string {
  if (typeof data === "string") return extractApiErrorDetail(data);
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const detail = record.error ?? record.message ?? record.detail;
    if (typeof detail === "string") return detail;
    try {
      return JSON.stringify(data);
    } catch {
      return "";
    }
  }
  return "";
}

/** The server's error detail for a failed request, or `""` if unavailable. */
export async function getApiErrorDetail(error: unknown): Promise<string> {
  if (!(error instanceof Error)) return "";

  if ("data" in error) {
    const detail = extractApiErrorData(
      (error as { data?: unknown }).data,
    );
    if (detail) return detail;
  }

  // Errors not produced by ky (hand-built, or from other layers) may still
  // carry an unconsumed response body.
  const response = "response" in error
    ? (error as { response?: Response }).response
    : undefined;
  if (!response) return "";
  try {
    return extractApiErrorDetail(await response.clone().text());
  } catch {
    // Already consumed — nothing further to recover.
    return "";
  }
}

export async function getApiErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (!(error instanceof Error)) return fallback;

  const detail = await getApiErrorDetail(error);

  return detail ? `${error.message}: ${detail}` : error.message;
}

// ── BFF session / CSRF state (set by AuthProvider) ───────────────

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | undefined;

/**
 * Set the non-secret CSRF token paired with the HttpOnly BFF session cookie.
 * It intentionally lives only in memory and is never a reusable login secret.
 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * Register a callback invoked when the BFF returns 401. The auth store uses
 * this to clear the local token and force re-login.
 */
export function setOnUnauthorized(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

// ── localStorage namespace helper ────────────────────────────────

export const NAMESPACE_HEADER = "X-Ferrum-Namespace";
/** Mark a documented fleet-global gateway operation so no tenant header is implied. */
export const FLEET_GLOBAL = "fleetGlobal";

const NAMESPACE_STORAGE_KEY = "ferrum:namespace";
const DEFAULT_NAMESPACE = "ferrum";

function getNamespace(): string {
  try {
    return localStorage.getItem(NAMESPACE_STORAGE_KEY) ?? DEFAULT_NAMESPACE;
  } catch {
    return DEFAULT_NAMESPACE;
  }
}

// ── Expected probe failures ──────────────────────────────────────

/**
 * Mode-dependent observability endpoints that legitimately return 404/503
 * on gateways where the feature is inactive (non-mesh mode, DP mode, no
 * chargeback plugin, ...). Their pages render a friendly empty state, so
 * the global error popup stays quiet for them.
 */
const SILENT_PROBE_PATTERNS = [
  /\/api\/proxy\/mesh\//,
  /\/api\/proxy\/node-waypoint\//,
  /\/api\/proxy\/service-waypoint\//,
  /\/api\/proxy\/gateway-trust/,
  /\/api\/proxy\/charges/,
  /\/api\/proxy\/backend-capabilities/,
  /\/api\/proxy\/api-specs/,
  /\/api\/proxy\/audit/,
];

/**
 * Per-request opt-out from the global error popup, for calls whose failure is
 * a meaningful result the caller handles itself rather than a fault to report.
 *
 * Pass as `{ context: { [SILENT_ERRORS]: true } }`. The canonical case is the
 * unconfirmed `DELETE /namespaces/{name}`: its 409 *is* the gateway's "this
 * namespace is not empty" answer, which the delete flow turns into a cascade
 * confirmation. Surfacing a raw API Error dialog over that would be wrong.
 */
export const SILENT_ERRORS = "silentErrors";

function isExpectedProbeFailure(response: Response): boolean {
  if (response.status !== 404 && response.status !== 503 && response.status !== 501) {
    return false;
  }
  return SILENT_PROBE_PATTERNS.some((pattern) => pattern.test(response.url));
}

// ── Configured ky instance ───────────────────────────────────────

export const api = ky.create({
  // Root-anchor every BFF path. With an empty prefix ky resolves
  // `api/auth/session` against the document URL, so a deep link or refresh on
  // a nested route such as `/proxies/<id>` would request
  // `/proxies/api/auth/session` and break authentication.
  prefix: "/",
  credentials: "same-origin",
  hooks: {
    beforeRequest: [
      ({ request, options }) => {
        // Attach the active namespace header to every proxy request, unless
        // the caller already scoped this one to a specific namespace (e.g.
        // counting a delete target's resources while a different namespace is
        // selected).
        if (
          request.url.includes("/api/proxy/") &&
          !options.context?.[FLEET_GLOBAL] &&
          !request.headers.has(NAMESPACE_HEADER)
        ) {
          request.headers.set(NAMESPACE_HEADER, getNamespace());
        }
        if (
          csrfToken &&
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.method !== "OPTIONS"
        ) {
          request.headers.set("X-CSRF-Token", csrfToken);
        }
      },
    ],
    afterResponse: [
      async ({ request, options, response }) => {
        await observeGatewayResponse(request, response);
        if (
          response.status === 401 &&
          response.headers.get("x-ferrum-auth-layer") === "bff"
        ) {
          unauthorizedHandler?.();
        }
        if (!response.ok) {
          if (options.context?.[SILENT_ERRORS]) return;
          if (isExpectedProbeFailure(response)) return;
          const body = await response.clone().text().catch(() => "");
          onApiError({
            statusCode: response.status,
            body,
            url: response.url,
          });
        }
      },
    ],
  },
});

// ── Proxy helper ─────────────────────────────────────────────────

/**
 * Returns a ky instance whose prefix is `/api/proxy/`.
 * Usage:  `proxyApi.get("proxies")` => GET /api/proxy/proxies
 */
export const proxyApi = api.extend({ prefix: "/api/proxy" });

setApplyStatusFetcher((epoch, sequence, waitMs) =>
  proxyApi
    .get("config/apply-status", {
      searchParams: { epoch, sequence, wait_ms: String(waitMs) },
      timeout: serverWaitTimeout(waitMs),
      retry: 0,
      context: { [SILENT_ERRORS]: true },
    })
    .json<ApplyStatusResponse>(),
);
