/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configured ky HTTP client                        */
/* ------------------------------------------------------------------ */

import ky from "ky";
import type { ApiError } from "./types";

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

export async function getApiErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (!(error instanceof Error)) return fallback;

  const response = "response" in error
    ? (error as { response?: Response }).response
    : undefined;
  const body = response ? await response.clone().text().catch(() => "") : "";
  const detail = extractApiErrorDetail(body);

  return detail ? `${error.message}: ${detail}` : error.message;
}

// ── BFF bearer token (set by AuthProvider) ───────────────────────

let bearerToken: string | null = null;
let unauthorizedHandler: (() => void) | undefined;

/**
 * Set the BFF bearer token attached to every request. Pass `null` to clear.
 * Called by `AuthProvider` whenever the auth state changes.
 */
export function setBearerToken(token: string | null): void {
  bearerToken = token;
}

/**
 * Register a callback invoked when the BFF returns 401. The auth store uses
 * this to clear the local token and force re-login.
 */
export function setOnUnauthorized(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

// ── localStorage namespace helper ────────────────────────────────

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

function isExpectedProbeFailure(response: Response): boolean {
  if (response.status !== 404 && response.status !== 503 && response.status !== 501) {
    return false;
  }
  return SILENT_PROBE_PATTERNS.some((pattern) => pattern.test(response.url));
}

// ── Configured ky instance ───────────────────────────────────────

export const api = ky.create({
  prefix: "",
  hooks: {
    beforeRequest: [
      ({ request }) => {
        // Attach the current namespace header to every proxy request
        request.headers.set("X-Ferrum-Namespace", getNamespace());
        // Attach the BFF bearer token if the user is signed in
        if (bearerToken) {
          request.headers.set("Authorization", `Bearer ${bearerToken}`);
        }
      },
    ],
    afterResponse: [
      async ({ response }) => {
        if (response.status === 401) {
          unauthorizedHandler?.();
        }
        if (!response.ok) {
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
