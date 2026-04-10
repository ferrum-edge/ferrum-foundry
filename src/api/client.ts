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
export function setApiErrorHandler(handler: ApiErrorHandler): void {
  errorHandler = handler;
}

/**
 * Dispatch an API error to the registered handler (if any).
 */
export function onApiError(error: ApiError): void {
  errorHandler?.(error);
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

// ── Configured ky instance ───────────────────────────────────────

export const api = ky.create({
  prefixUrl: "",
  hooks: {
    beforeRequest: [
      (request) => {
        // Attach the current namespace header to every proxy request
        request.headers.set("X-Ferrum-Namespace", getNamespace());
      },
    ],
    afterResponse: [
      async (_request, _options, response) => {
        if (!response.ok) {
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
 * Returns a ky instance whose prefixUrl is `/api/proxy/`.
 * Usage:  `proxyApi.get("proxies")` => GET /api/proxy/proxies
 */
export const proxyApi = api.extend({ prefixUrl: "/api/proxy" });
