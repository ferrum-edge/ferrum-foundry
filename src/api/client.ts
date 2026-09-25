/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – configured ky HTTP client                        */
/* ------------------------------------------------------------------ */

import ky, { isHTTPError, type Options } from "ky";
import { serverWaitTimeout } from "../../server/waitBudget";
import type { ApiError } from "./types";
import {
  beginGatewayRequest,
  classifyCommittedWrite,
  GATEWAY_REQUEST_IDENTITY,
  observeGatewayFailure,
  observeGatewayResponse,
  setApplyStatusFetcher,
  type ApplyStatusResponse,
  type CommittedWrite,
  type GatewayRequestIdentity,
} from "./gatewayMetadata";

// ── Global error handler (event-emitter style) ───────────────────

type ApiErrorHandler = (error: ApiError) => void;

let errorHandler: ApiErrorHandler | undefined;

/**
 * Register a handler for terminal API failures after their owner's retries.
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

/**
 * Gateway summaries that are contract constants and carry no information, so a
 * structured `code` supersedes rather than repeats them. `ApiSpecParseError`
 * documents `error` as *always* the literal below.
 */
const CONTENT_FREE_SUMMARIES = new Set(["Spec parse failed"]);

/** Ceiling for a single gateway-supplied field carried into an operator toast. */
const MAX_FIELD_LENGTH = 600;

/**
 * Bound one gateway-supplied string: strip control characters that would let a
 * rejected document smuggle terminal or layout escapes into the toast, and cap
 * the length so a parser dump cannot fill the screen. Newlines and tabs are
 * kept — they are how multi-part details stay readable.
 */
function boundField(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return cleaned.length > MAX_FIELD_LENGTH
    ? `${cleaned.slice(0, MAX_FIELD_LENGTH)}…`
    : cleaned;
}

/**
 * Flatten one gateway error body into operator-facing text.
 *
 * The field list is the union of the upstream error schemas Foundry can
 * receive: the generic `Error` (`error`, with `message`/`detail` accepted from
 * non-gateway layers), `ApiSpecValidationError` (`failures[]`), and
 * `ApiSpecParseError` (`code` + `details`). Add a branch here — not at a call
 * site — when a new shape appears, or its content is silently discarded.
 */
function errorRecordDetail(record: Record<string, unknown>): string | null {
  const heading = record.error ?? record.message ?? record.detail;
  const summary = typeof heading === "string" ? heading : null;
  const code = typeof record.code === "string" ? boundField(record.code) : "";
  const details = typeof record.details === "string" ? boundField(record.details) : "";
  if (summary === null && !code && !details) return null;

  const lines: string[] = [];
  if (summary !== null && !(code && CONTENT_FREE_SUMMARIES.has(summary.trim()))) {
    lines.push(summary);
  }
  if (code) lines.push(details ? `${code}: ${details}` : code);
  else if (details) lines.push(details);

  if (Array.isArray(record.failures)) {
    for (const failure of record.failures) {
      if (!failure || typeof failure !== "object") continue;
      const item = failure as Record<string, unknown>;
      if (typeof item.resource_type !== "string" || !Array.isArray(item.errors)) continue;
      const label = item.resource_type + (typeof item.id === "string" ? ` (${item.id})` : "");
      for (const message of item.errors) {
        if (typeof message === "string" && message.trim()) lines.push(`${label}: ${message}`);
      }
    }
  }
  return lines.join("\n");
}

export function extractApiErrorDetail(body: string): string {
  if (!body.trim()) return "";

  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const detail = errorRecordDetail(record);
      if (detail !== null) return detail;
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
    const detail = errorRecordDetail(record);
    if (detail !== null) return detail;
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

export const UNOBSERVED_WRITE_MESSAGE =
  "Outcome unknown: the gateway may already have committed this change. " +
  "It was not replayed. Re-read the current configuration before retrying.";

/**
 * Operator-facing report of a committed-but-not-live write. It uses the
 * live-apply banner's own words ("Committed, not yet proven live") and points
 * at the banner, which carries the cursor and the runtime verdict; it never
 * says the change failed, because it did not.
 *
 * `summary` names what was saved, e.g. `"Proxy saved"`.
 */
export function committedWriteMessage(summary: string, committed: CommittedWrite): string {
  const reason = committed.reason ? ` Reason: ${committed.reason}.` : "";
  return `${summary}: committed, not yet proven live.${reason} ` + (committed.cursor
    ? `See the live-apply banner for cursor ${committed.cursor} and runtime status.`
    : "No valid apply cursor was provided; verify the live gateway configuration.");
}

export async function getApiErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (!(error instanceof Error)) return fallback;

  const detail = await getApiErrorDetail(error);

  // Never phrase a write whose answer was lost as a failure.
  if (isUnobservedWrite(error)) {
    return detail ? `${UNOBSERVED_WRITE_MESSAGE}\n${detail}` : UNOBSERVED_WRITE_MESSAGE;
  }
  // Nor one the gateway says it committed.
  const committed = getCommittedWrite(error);
  if (committed) return committedWriteMessage("The change was saved", committed);
  return detail ? `${error.message}: ${detail}` : error.message;
}

// Deferred notifications follow the actual rejected Error, not a URL shared
// with concurrent operations. Only the terminal Query error consumes one.
const deferredQueryErrors = new WeakMap<object, ApiError>();

export function reportRequestError(error: unknown, detail: ApiError, defer = false): void {
  if (defer && error instanceof Error) deferredQueryErrors.set(error, detail);
  else onApiError(detail);
}

export function reportDeferredQueryError(error: unknown): void {
  if (!error || typeof error !== "object") return;
  const detail = deferredQueryErrors.get(error);
  if (!detail) return;
  deferredQueryErrors.delete(error);
  onApiError(detail);
}

// Writes whose answer never arrived (see `observeGatewayFailure`). Keyed by the
// rejected Error so a caller that wraps it (via `cause`) is still recognized.
const unobservedWrites = new WeakSet<object>();

/**
 * Carry the unobserved-write marker onto an error that deliberately replaces
 * the original rather than wrapping it via `cause` (for example to avoid
 * retaining a secret-bearing request).
 */
export function markUnobservedWrite<T extends object>(error: T): T {
  unobservedWrites.add(error);
  return error;
}

/**
 * Whether `error` is, or was caused by, a configuration write whose outcome
 * Foundry could not observe. Such a write may have committed; it was not
 * replayed, and cached reads must be refreshed before anyone retries it.
 */
export function isUnobservedWrite(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (unobservedWrites.has(current)) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Writes the gateway durably committed but answered `503` because the live
// apply lagged (see `committedNotLiveAnswer`). Keyed like `unobservedWrites`.
const committedWrites = new WeakMap<object, CommittedWrite>();

/**
 * Carry the committed-write marker onto an error that deliberately replaces
 * the original rather than wrapping it via `cause`.
 */
export function markCommittedWrite<T extends object>(error: T, committed: CommittedWrite): T {
  committedWrites.set(error, committed);
  return error;
}

/**
 * The commit `error` reports, when it is — or was caused by — a configuration
 * write the gateway answered with the committed-but-not-live `503`.
 *
 * Such a write is **not a failure**: the row is durable and only the live
 * apply lagged. It is never retried (the retry policy refuses it), the global
 * error popup is not shown for it (the live-apply banner already reports the
 * lag), cached reads are refreshed (`src/lib/queryClient.ts`), and an editor
 * that issued it reseeds from the gateway rather than keeping a baseline that
 * predates its own commit. See `docs/concurrent-edits.md`.
 */
export function getCommittedWrite(error: unknown): CommittedWrite | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    const committed = committedWrites.get(current);
    if (committed) return committed;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isCommittedWrite(error: unknown): boolean {
  return getCommittedWrite(error) !== null;
}

// ── BFF session / CSRF state (set by AuthProvider) ───────────────

/**
 * Context key carrying a request's position in the order requests were
 * issued. A late BFF `401` is only evidence about the session if nothing newer
 * has been accepted since the request was sent (#435).
 */
export const REQUEST_TICKET = "requestTicket";

/** Called with the ticket of the request the BFF answered `401`. */
export type UnauthorizedHandler = (ticket: number) => void;

let csrfToken: string | null = null;
let csrfCookie: string | null = null;
let unauthorizedHandler: UnauthorizedHandler | undefined;
let lastTicket = 0;

/**
 * Take the next request ticket. Tickets are strictly increasing across every
 * request this tab sends, so the auth store can order a session read against
 * any other request's `401`.
 */
export function issueRequestTicket(): number {
  lastTicket += 1;
  return lastTicket;
}

/** The newest ticket issued so far; every request in flight holds one at or below it. */
export function latestRequestTicket(): number {
  return lastTicket;
}

/**
 * Set the non-secret CSRF token paired with the HttpOnly BFF session cookie.
 * It intentionally lives only in memory and is never a reusable login secret.
 *
 * `cookieName` names the readable CSRF cookie the BFF issued with it. The
 * cookie is shared by every tab, and a renewal in one tab replaces it for all
 * of them (#436), so an unsafe request sends the cookie's current value and
 * falls back to this token only when the cookie cannot be read.
 */
export function setCsrfToken(token: string | null, cookieName?: string): void {
  csrfToken = token;
  csrfCookie = token === null ? null : cookieName ?? null;
}

function readCookie(name: string): string | null {
  let cookies: string;
  try {
    cookies = typeof document === "undefined" ? "" : document.cookie;
  } catch {
    return null;
  }
  for (const entry of cookies.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return value || null;
    }
  }
  return null;
}

/**
 * The CSRF value for an unsafe request, or null while signed out. The BFF
 * requires the header to equal the cookie the browser sends with this very
 * request, and it still verifies the value itself, so reading the cookie
 * accepts nothing the server would not.
 */
function currentCsrfToken(): string | null {
  if (!csrfToken) return null;
  return (csrfCookie && readCookie(csrfCookie)) || csrfToken;
}

/**
 * Register a callback invoked when the BFF returns 401. The auth store uses
 * this to clear the local token and force re-login. Returns an unregister
 * function that leaves a replacement's handler in place.
 */
export function setOnUnauthorized(handler: UnauthorizedHandler | undefined): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = undefined;
  };
}

// ── Namespace binding ────────────────────────────────────────────

export const NAMESPACE_HEADER = "X-Ferrum-Namespace";
/** Mark a documented fleet-global gateway operation so no tenant header is implied. */
export const FLEET_GLOBAL = "fleetGlobal";
/** The enclosing Query owns notification after all of its retries finish. */
export const DEFER_QUERY_ERRORS = "deferQueryErrors";
export const QUERY_ERROR_CONTEXT = { [DEFER_QUERY_ERRORS]: true };

/**
 * The namespace an operation is bound to.
 *
 * Every namespace-scoped API function takes a scope as its first argument and
 * stamps `X-Ferrum-Namespace` from it on each request it makes — the first
 * page and every following page of a `listAll()`, the preflight, apply, and
 * rollback calls of a membership plan, and the mutation itself. The scope is
 * captured once, by the hook or component that starts the operation, from
 * `useNamespace()`; it is never re-read from storage mid-flight, so a
 * namespace switch in this tab or another one cannot retarget a running
 * operation. See `src/stores/namespace.tsx`.
 */
export interface NamespaceScope {
  readonly namespace: string;
  readonly [DEFER_QUERY_ERRORS]?: boolean;
}

export function queryScope(scope: NamespaceScope): NamespaceScope {
  return { ...scope, [DEFER_QUERY_ERRORS]: true };
}

type ScopedOptions = Omit<Options, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * Build ky options that pin a gateway request to `scope.namespace`. The
 * header is set explicitly here rather than looked up by a hook so that the
 * outgoing request carries the operation's own binding and nothing else.
 */
export function scoped(
  scope: NamespaceScope,
  options: ScopedOptions = {},
): Options {
  if (typeof scope.namespace !== "string" || scope.namespace.length === 0) {
    throw new Error("Gateway request requires a non-empty namespace scope");
  }
  const { headers, ...rest } = options;
  return {
    ...rest,
    context: { ...rest.context, ...(scope[DEFER_QUERY_ERRORS] && { [DEFER_QUERY_ERRORS]: true }) },
    headers: { ...headers, [NAMESPACE_HEADER]: scope.namespace },
  };
}

/**
 * Thrown when a gateway request reaches the wire without a namespace binding.
 * Sending such a request would force the client to invent a namespace — the
 * exact failure this client refuses to have — so it fails closed instead.
 */
export class UnboundNamespaceError extends Error {
  constructor(url: string) {
    super(
      `Gateway request ${url} has no namespace binding; pass a NamespaceScope ` +
        "(or mark the call FLEET_GLOBAL)",
    );
    this.name = "UnboundNamespaceError";
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
  /\/api\/proxy\/mesh\//, // Includes runtime-overlay: documented absent/temporarily unavailable probes.
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

/**
 * Per-request list of HTTP statuses the caller turns into its own outcome.
 * Narrower than `SILENT_ERRORS`: any other failure on the same request still
 * reaches the global error popup.
 *
 * Pass as `{ context: { [HANDLED_STATUSES]: [412] } }`. The canonical case is
 * a conditional full-replacement `PUT` (`src/api/conditionalWrite.ts`), whose
 * `412` becomes a re-verification or the stale-write dialog rather than a raw
 * API error.
 */
export const HANDLED_STATUSES = "handledStatuses";

function isHandledStatus(context: Record<string, unknown>, status: number): boolean {
  const handled = context[HANDLED_STATUSES];
  return Array.isArray(handled) && handled.includes(status);
}

function isExpectedProbeFailure(response: Response, requestUrl: string): boolean {
  if (response.status !== 404 && response.status !== 503 && response.status !== 501) {
    return false;
  }
  return SILENT_PROBE_PATTERNS.some((pattern) => pattern.test(requestUrl));
}

// ── Configured ky instance ───────────────────────────────────────

export const api = ky.create({
  // Root-anchor every BFF path. With an empty prefix ky resolves
  // `api/auth/session` against the document URL, so a deep link or refresh on
  // a nested route such as `/proxies/<id>` would request
  // `/proxies/api/auth/session` and break authentication.
  prefix: "/",
  credentials: "same-origin",
  retry: {
    // A failed write may already be committed. Even full-replace PUTs and
    // indexed credential DELETEs must surface the error without replay.
    // ky checks methods before Retry-After, so that header cannot opt writes in.
    limit: 2,
    methods: ["get", "head", "options"],
    statusCodes: [408, 413, 429, 500, 502, 503, 504],
    shouldRetry: ({ error }) => {
      // A committed-but-not-live response is never permission to retry,
      // even if its body is missing or it unexpectedly arrives on a read.
      if (
        isHTTPError(error) &&
        error.response.status === 503 &&
        (error.response.headers.has("x-ferrum-config-cursor") ||
          (error.data && typeof error.data === "object" &&
            "applied" in error.data && error.data.applied === false))
      ) {
        return false;
      }
      return undefined;
    },
  },
  hooks: {
    beforeRequest: [
      ({ request, options }) => {
        // Every gateway request must already carry the namespace its
        // operation was bound to (via `scoped()`), or be a documented
        // fleet-global call. The client never picks a namespace itself: the
        // old per-request localStorage read let another tab's switch — or a
        // switch between two pages of one listing — silently retarget a
        // request while the UI still displayed the original namespace.
        if (
          request.url.includes("/api/proxy/") &&
          !options.context?.[FLEET_GLOBAL] &&
          !request.headers.has(NAMESPACE_HEADER)
        ) {
          throw new UnboundNamespaceError(request.url);
        }
        // ky shallow-copies context for each request; set a fresh identity
        // without replacing the read-only normalized context property.
        options.context[GATEWAY_REQUEST_IDENTITY] = beginGatewayRequest(request);
        // A caller that ordered itself against the auth store (a session
        // read) brings its own ticket; every other request takes the next one.
        if (typeof options.context[REQUEST_TICKET] !== "number") {
          options.context[REQUEST_TICKET] = issueRequestTicket();
        }
        const csrf = currentCsrfToken();
        if (
          csrf &&
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.method !== "OPTIONS"
        ) {
          request.headers.set("X-CSRF-Token", csrf);
        }
      },
    ],
    afterResponse: [
      async ({ request, options, response }) => {
        await observeGatewayResponse(
          request,
          response,
          options.context[GATEWAY_REQUEST_IDENTITY] as GatewayRequestIdentity | undefined,
        );
        if (
          response.status === 401 &&
          response.headers.get("x-ferrum-auth-layer") === "bff"
        ) {
          unauthorizedHandler?.(options.context[REQUEST_TICKET] as number);
        }
      },
    ],
    beforeError: [
      ({ request, options, error }) => {
        const identity = options.context[GATEWAY_REQUEST_IDENTITY] as
          | GatewayRequestIdentity
          | undefined;
        // Classified before any popup opt-out: a silent caller's write is just
        // as ambiguous, and the live-apply banner must still say so.
        const unobserved = observeGatewayFailure(request, error, identity);
        if (unobserved) unobservedWrites.add(error);
        // A configuration write answered with the committed-but-not-live 503
        // did commit. It is marked for callers and never reported as a failure:
        // the live-apply banner (`observeGatewayResponse`) already says the
        // change is committed and not yet proven live.
        const committed =
          identity?.mutationOrder !== undefined ? classifyCommittedWrite(error) : null;
        if (committed) {
          committedWrites.set(error, committed);
          return error;
        }
        if (options.context[SILENT_ERRORS] || error.name === "AbortError") return error;
        if (isHTTPError(error) && isExpectedProbeFailure(error.response, request.url)) return error;
        if (isHTTPError(error) && isHandledStatus(options.context, error.response.status)) return error;
        const data = isHTTPError(error) ? error.data : error.message;
        reportRequestError(error, {
          statusCode: isHTTPError(error) ? error.response.status : 0,
          body: typeof data === "string" ? data : data === undefined ? "" : JSON.stringify(data),
          url: request.url,
          ...(unobserved && { outcome: unobserved }),
        }, Boolean(options.context[DEFER_QUERY_ERRORS]));
        return error;
      },
    ],
  },
});

// ── Proxy helper ─────────────────────────────────────────────────

/**
 * Returns a ky instance whose prefix is `/api/proxy/`.
 * Usage:  `proxyApi.get("proxies", scoped(scope))` => GET /api/proxy/proxies
 * with `X-Ferrum-Namespace: <scope.namespace>`.
 */
export const proxyApi = api.extend({ prefix: "/api/proxy" });

// The apply-status poll is a follow-up of the mutation that produced the
// cursor, so it inherits that mutation's binding: the same namespace header,
// or fleet-global when the mutation itself was fleet-global. Its client
// timeout is sized to the server-side wait it requests (#204).
setApplyStatusFetcher((epoch, sequence, waitMs, namespace) => {
  const options = {
    searchParams: { epoch, sequence, wait_ms: String(waitMs) },
    timeout: serverWaitTimeout(waitMs),
    retry: 0,
    context: { [SILENT_ERRORS]: true, [FLEET_GLOBAL]: namespace === null },
  };
  return proxyApi
    .get(
      "config/apply-status",
      namespace === null ? options : scoped({ namespace }, options),
    )
    .json<ApplyStatusResponse>();
});
