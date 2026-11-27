/* ------------------------------------------------------------------ */
/*  Diagnostic reference lookup (ADR 0001)                             */
/* ------------------------------------------------------------------ */

/**
 * Resolves an Edge `X-Ferrum-Diagnostic-Ref` value through
 * `GET /diagnostics/v1/refs/{ref}` on the configured gateway, within the
 * boundary ADR 0001 sets for diagnostic presentation:
 *
 * - The browser sends one typed reference, in the `X-Ferrum-Diagnostic-Ref`
 *   request header of `GET /api/diagnostics/lookup`, and its tab's namespace
 *   binding; never a URL, path, query or credential. The reference stays out
 *   of the request target, so no access or error log on the way (the BFF's,
 *   a reverse proxy's) records it. The target is the deployment's
 *   `FERRUM_ADMIN_URL`.
 * - Edge requires the `diagnostics:read` scope, which no role implies. Only a
 *   role listed in `FERRUM_DIAGNOSTICS_ROLES` (empty by default) receives it,
 *   on a short-lived token minted for this one lookup and bound to the one
 *   namespace the session is authorized for. The UI hides the lookup from
 *   other roles; this route refuses them regardless.
 * - Budgets: at most 4 KiB of reference header, one namespace, 64 KiB of
 *   response read before parsing, eight levels of nesting, a five-second
 *   absolute deadline, and bounded concurrency per principal and overall.
 * - The answer is a reviewed projection with bounded strings; failures are
 *   fixed messages with fixed codes, never a raw gateway body.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { fetch } from 'undici';
import { signAdminJwt } from '../../shared/admin-jwt.js';
import { isNamespaceName } from '../../shared/namespace.js';
import { requireAdminAuth } from '../auth.js';
import type { AuthPrincipal } from '../auth-types.js';
import { loadConfig, type Config } from '../config.js';
import { rejectStaleGatewayTarget, stampGatewayTarget } from '../gateway-target.js';
import { getDispatcher } from '../tls.js';

export const DIAGNOSTICS_SCOPE = 'diagnostics:read';
export const DIAGNOSTIC_REF_PATTERN = /^(?:fd1_[0-9a-f]{32}|fd2_[0-9a-f]{8}_[0-9a-f]{32})$/;
const REPLICA_ID_PATTERN = /^[0-9a-f]{8}$/;
const SCHEMA_VERSION = 'ferrum.diagnostic_ref.v1';
export const LOOKUP_PATH = '/api/diagnostics/lookup';
export const DIAGNOSTIC_REF_HEADER = 'x-ferrum-diagnostic-ref';
/** The earlier path form; answered with a fixed refusal, never routed. */
const LEGACY_PREFIX = '/api/diagnostics/refs/';
const ABSOLUTE_URL_ORIGIN_PATTERN = /^https?:\/\/[^/]+/;
const ASCII_PERCENT_ESCAPE_PATTERN = /%([0-7][0-9a-f])/gi;
const PORT_PATTERN = /^\d{1,5}$/;
const EXPLICIT_PORT_PATTERN = /:(\d{1,5})$/;
const AUTHORITY_END_PATTERN = /[/?#]/;

export const DIAGNOSTIC_LIMITS = {
  /** The reference header, in bytes. */
  maxRequestBytes: 4 * 1024,
  /** Upstream response bytes read before parsing. */
  maxResponseBytes: 64 * 1024,
  maxDepth: 8,
  deadlineMs: 5000,
  maxActive: 8,
  maxActivePerPrincipal: 2,
  /** Every projected string, in characters. */
  maxStringLength: 256,
  /** Edge returns at most eight attempts. */
  maxAttempts: 8,
  /** Lifetime of the per-lookup token, in seconds. */
  tokenTtlSeconds: 60,
} as const;

type FailureCode =
  | 'FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED'
  | 'FERRUM_BFF_DIAGNOSTIC_REF_INVALID'
  | 'FERRUM_BFF_DIAGNOSTIC_NAMESPACE'
  | 'FERRUM_BFF_DIAGNOSTICS_CAPACITY'
  | 'FERRUM_BFF_DIAGNOSTIC_NOT_FOUND'
  | 'FERRUM_BFF_DIAGNOSTICS_DENIED'
  | 'FERRUM_BFF_DIAGNOSTICS_RATE_LIMITED'
  | 'FERRUM_BFF_DIAGNOSTICS_TIMEOUT'
  | 'FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE';

const FAILURES: Record<FailureCode, { status: number; error: string }> = {
  FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED: {
    status: 403,
    error: 'Diagnostic lookup is not enabled for your role (FERRUM_DIAGNOSTICS_ROLES)',
  },
  FERRUM_BFF_DIAGNOSTIC_REF_INVALID: {
    status: 400,
    error: 'Send one X-Ferrum-Diagnostic-Ref header: fd1_<32 hex> or fd2_<8 hex>_<32 hex>, and no query',
  },
  FERRUM_BFF_DIAGNOSTIC_NAMESPACE: {
    status: 403,
    error: 'Diagnostic lookup needs one X-Ferrum-Namespace your session is granted',
  },
  FERRUM_BFF_DIAGNOSTICS_CAPACITY: { status: 429, error: 'Too many diagnostic lookups in flight' },
  FERRUM_BFF_DIAGNOSTIC_NOT_FOUND: {
    status: 404,
    error: 'No diagnostic reference matches in this namespace on this gateway process, or it expired',
  },
  FERRUM_BFF_DIAGNOSTICS_DENIED: { status: 403, error: 'The gateway refused the diagnostic lookup' },
  FERRUM_BFF_DIAGNOSTICS_RATE_LIMITED: { status: 429, error: 'The gateway rate-limited diagnostic lookups' },
  FERRUM_BFF_DIAGNOSTICS_TIMEOUT: { status: 504, error: 'The diagnostic lookup did not finish in time' },
  FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE: { status: 502, error: 'The diagnostic lookup is unavailable' },
};

function fail(reply: FastifyReply, code: FailureCode, extra: Record<string, unknown> = {}) {
  const { status, error } = FAILURES[code];
  if (status === 429) reply.header('retry-after', '1');
  return reply.status(status).header('cache-control', 'no-store').send({ error, code, ...extra });
}

/** Whether `principal`'s role is one the deployment named for diagnostic lookup. */
export function diagnosticsPermitted(config: Pick<Config, 'diagnosticsRoles'>, principal: AuthPrincipal): boolean {
  return config.diagnosticsRoles.includes(principal.role);
}

/* ---------- Projection ---------- */

export interface DiagnosticAttempt {
  attempt: number;
  backend_dispatch: string;
  status?: number;
  error_class?: string;
  tls?: { failure: string; reason?: string };
}

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
    backend_target: string | null;
    duration_bucket: string;
    rejection?: { source: string; phase: string; plugin?: string };
    attempts: DiagnosticAttempt[];
    attempts_omitted?: number;
  };
}

class ProjectionError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectionError();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new ProjectionError();
  return value.length > DIAGNOSTIC_LIMITS.maxStringLength
    ? value.slice(0, DIAGNOSTIC_LIMITS.maxStringLength)
    : value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ProjectionError();
  return value;
}

/**
 * The backend target as `scheme://host:port` only. Edge renders no
 * credentials here; dropping user-info, path, query and fragment anyway keeps
 * this surface structurally unable to show one.
 */
export function structuralTarget(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ProjectionError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  // `URL` drops a port equal to the scheme default; keep the one Edge wrote.
  const authority = value.slice(url.protocol.length + 2).split(AUTHORITY_END_PATTERN, 1)[0].split('@').pop() ?? '';
  const explicit = EXPLICIT_PORT_PATTERN.exec(authority)?.[1];
  const port = url.port || (explicit && PORT_PATTERN.test(explicit) ? explicit : '');
  const target = `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}`;
  // A structural form longer than the string bound is omitted, not cut.
  return target.length > DIAGNOSTIC_LIMITS.maxStringLength ? null : target;
}

function depth(value: unknown, level = 1): number {
  if (!value || typeof value !== 'object') return level - 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  let deepest = level;
  for (const child of children) {
    deepest = Math.max(deepest, depth(child, level + 1));
    if (deepest > DIAGNOSTIC_LIMITS.maxDepth) return deepest;
  }
  return deepest;
}

/** The reviewed fields of Edge's `DiagnosticRefLookup`, nothing else. */
export function projectDiagnosticLookup(body: unknown): DiagnosticLookup {
  if (depth(body) > DIAGNOSTIC_LIMITS.maxDepth) throw new ProjectionError();
  const source = record(body);
  // Only the reviewed shape: another schema version, a non-Boolean
  // `detail_available`, or a non-array `attempts` is refused, never coerced.
  if (source.schema_version !== SCHEMA_VERSION || typeof source.detail_available !== 'boolean') {
    throw new ProjectionError();
  }
  const lookup: DiagnosticLookup = {
    schema_version: SCHEMA_VERSION,
    ref: text(source.ref),
    namespace: text(source.namespace),
    created_at: text(source.created_at),
    expires_at: text(source.expires_at),
    protocol: text(source.protocol),
    status: integer(source.status),
    gateway_error: nullableText(source.gateway_error),
    detail_available: source.detail_available,
  };
  const replica = optionalText(source.replica_id);
  if (replica !== undefined) lookup.replica_id = replica;
  if (source.detail !== undefined && source.detail !== null) {
    const detail = record(source.detail);
    if (detail.attempts !== undefined && !Array.isArray(detail.attempts)) throw new ProjectionError();
    const attempts: unknown[] = Array.isArray(detail.attempts) ? detail.attempts : [];
    lookup.detail = {
      error_class: nullableText(detail.error_class),
      body_error_class: nullableText(detail.body_error_class),
      rejection_phase: nullableText(detail.rejection_phase),
      route_timeout_phase: nullableText(detail.route_timeout_phase),
      backend_dispatch: text(detail.backend_dispatch),
      proxy_id: nullableText(detail.proxy_id),
      backend_target: structuralTarget(detail.backend_target),
      duration_bucket: text(detail.duration_bucket),
      attempts: attempts.slice(0, DIAGNOSTIC_LIMITS.maxAttempts).map((entry) => {
        const attempt = record(entry);
        const projected: DiagnosticAttempt = {
          attempt: integer(attempt.attempt),
          backend_dispatch: text(attempt.backend_dispatch),
        };
        if (attempt.status !== undefined) projected.status = integer(attempt.status);
        const errorClass = optionalText(attempt.error_class);
        if (errorClass !== undefined) projected.error_class = errorClass;
        if (attempt.tls !== undefined && attempt.tls !== null) {
          const tls = record(attempt.tls);
          projected.tls = { failure: text(tls.failure) };
          const reason = optionalText(tls.reason);
          if (reason !== undefined) projected.tls.reason = reason;
        }
        return projected;
      }),
    };
    if (detail.rejection !== undefined && detail.rejection !== null) {
      const rejection = record(detail.rejection);
      lookup.detail.rejection = { source: text(rejection.source), phase: text(rejection.phase) };
      const plugin = optionalText(rejection.plugin);
      if (plugin !== undefined) lookup.detail.rejection.plugin = plugin;
    }
    const omitted = detail.attempts_omitted;
    const extra = attempts.length > DIAGNOSTIC_LIMITS.maxAttempts ? attempts.length - DIAGNOSTIC_LIMITS.maxAttempts : 0;
    if (omitted !== undefined || extra > 0) {
      lookup.detail.attempts_omitted = (omitted === undefined ? 0 : integer(omitted)) + extra;
    }
  }
  return lookup;
}

/* ---------- Upstream read ---------- */

class OversizedResponseError extends Error {}

async function boundedText(body: Awaited<ReturnType<typeof fetch>>['body']): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DIAGNOSTIC_LIMITS.maxResponseBytes) throw new OversizedResponseError();
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

let deadlineMs: number = DIAGNOSTIC_LIMITS.deadlineMs;

/** Test seam: shorten the absolute deadline so a test need not wait five seconds. */
export function setDiagnosticDeadlineForTesting(ms: number | undefined): void {
  deadlineMs = ms ?? DIAGNOSTIC_LIMITS.deadlineMs;
}

/* ---------- Admission ---------- */

const active = new Map<string, number>();
let activeTotal = 0;

function admit(subject: string): boolean {
  const held = active.get(subject) ?? 0;
  if (activeTotal >= DIAGNOSTIC_LIMITS.maxActive || held >= DIAGNOSTIC_LIMITS.maxActivePerPrincipal) {
    return false;
  }
  active.set(subject, held + 1);
  activeTotal += 1;
  return true;
}

function release(subject: string): void {
  const held = active.get(subject) ?? 0;
  if (held <= 1) active.delete(subject);
  else active.set(subject, held - 1);
  activeTotal = Math.max(0, activeTotal - 1);
}

/* ---------- Request logging ---------- */

/** Whether a raw request target is under `/api/diagnostics/`, escapes decoded once. */
export function isDiagnosticsRequest(url: string | undefined): boolean {
  const path = (url ?? '').split('?', 1)[0].replace(ABSOLUTE_URL_ORIGIN_PATTERN, '');
  const decoded = path.replace(ASCII_PERCENT_ESCAPE_PATTERN, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return decoded.startsWith('/api/diagnostics/');
}

function httpStatusCode(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || !('statusCode' in value)) return null;
  const status = (value as { statusCode: unknown }).statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

/**
 * Installed at app construction, like the manifest preview's: a rejected
 * lookup target (which a mistaken client could fill with a credential-bearing
 * URL) never reaches a log line, and a malformed URL that bypasses routing
 * gets a fixed answer instead of Fastify's echo of the target.
 */
export const diagnosticsRequestLogging: Required<Pick<FastifyServerOptions, 'childLoggerFactory' | 'frameworkErrors'>> = {
  childLoggerFactory(logger, bindings, options, rawRequest) {
    if (!isDiagnosticsRequest(rawRequest.url)) return logger.child(bindings, options);
    return logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: () => ({ method: 'GET', url: '/api/diagnostics/…' }),
        res: (response: unknown) => ({ statusCode: httpStatusCode(response) }),
        err: (error: unknown) => ({
          type: 'Error', message: 'Diagnostic lookup failed', statusCode: httpStatusCode(error),
        }),
        msg: () => 'Diagnostic lookup request',
      },
    });
  },
  frameworkErrors(_error: unknown, request: FastifyRequest, reply: FastifyReply) {
    request.log.warn('Diagnostic lookup refused');
    return fail(reply, 'FERRUM_BFF_DIAGNOSTIC_REF_INVALID');
  },
};

/* ---------- Routes ---------- */

const diagnosticsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/diagnostics/config', { onRequest: requireAdminAuth }, async (request, reply) => {
    const principal = request.authPrincipal;
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    reply.header('cache-control', 'no-store');
    return { lookupPermitted: diagnosticsPermitted(loadConfig(), principal) };
  });

  // Any failure inside this plugin answers a fixed body; the raw error, which
  // may carry the request target, is never sent or logged.
  fastify.setErrorHandler((_error, request, reply) => {
    request.log.warn('Diagnostic lookup failed');
    return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE');
  });

  // The earlier path form put the reference in the request target, where a
  // proxy logs it. It is refused with a fixed body, never routed or echoed.
  fastify.get(`${LEGACY_PREFIX}*`, async (_request, reply) => fail(reply, 'FERRUM_BFF_DIAGNOSTIC_REF_INVALID'));

  fastify.get(
    LOOKUP_PATH,
    { onRequest: requireAdminAuth },
    async (request, reply) => {
      const config = loadConfig();
      const principal = request.authPrincipal;
      if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
      // Authorization first, so an unlisted role learns nothing about the input.
      if (!diagnosticsPermitted(config, principal)) return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED');

      const target = request.raw.url ?? request.url;
      const supplied = request.headers[DIAGNOSTIC_REF_HEADER];
      const ref = typeof supplied === 'string' ? supplied : '';
      if (
        target !== LOOKUP_PATH ||
        Buffer.byteLength(ref) > DIAGNOSTIC_LIMITS.maxRequestBytes ||
        !DIAGNOSTIC_REF_PATTERN.test(ref)
      ) {
        return fail(reply, 'FERRUM_BFF_DIAGNOSTIC_REF_INVALID');
      }
      // Bound to the gateway the page was loaded against: a lookup issued
      // before the tab saw a gateway change is refused, never sent to the new
      // gateway, where the reference cannot exist.
      if (!stampGatewayTarget(request, reply, config)) return rejectStaleGatewayTarget(reply);

      const header = request.headers['x-ferrum-namespace'];
      const namespace = typeof header === 'string' ? header.trim() : undefined;
      if (
        !namespace ||
        !isNamespaceName(namespace) ||
        (principal.namespaces !== undefined && !principal.namespaces.includes(namespace))
      ) {
        return fail(reply, 'FERRUM_BFF_DIAGNOSTIC_NAMESPACE');
      }

      if (!admit(principal.subject)) return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_CAPACITY');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      // A client that goes away abandons its lookup: abort the gateway request
      // so the admission slot is released now, not at the deadline.
      const abandon = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', abandon);
      try {
        const token = await signAdminJwt({
          secret: config.jwtSecret,
          issuer: config.jwtIssuer,
          subject: principal.subject,
          role: principal.role,
          audience: config.jwtAudience,
          namespaces: [namespace],
          scopes: [DIAGNOSTICS_SCOPE],
          ttlSeconds: Math.min(config.jwtTtl, DIAGNOSTIC_LIMITS.tokenTtlSeconds),
        });
        const url = new URL(config.adminUrl);
        url.pathname = `/diagnostics/v1/refs/${ref}`;
        url.search = '';
        const response = await fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'x-ferrum-provisioned-by': 'ferrum-foundry',
          },
          signal: controller.signal,
          dispatcher: getDispatcher(config),
          redirect: 'error',
        });
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);
          const owner = response.headers.get('x-ferrum-diagnostic-owner-replica');
          return fail(
            reply,
            'FERRUM_BFF_DIAGNOSTIC_NOT_FOUND',
            owner && REPLICA_ID_PATTERN.test(owner) ? { owner_replica: owner } : {},
          );
        }
        if (response.status === 403 || response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_DENIED');
        }
        if (response.status === 429) {
          await response.body?.cancel().catch(() => undefined);
          return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_RATE_LIMITED');
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE');
        }
        const raw = await boundedText(response.body);
        const lookup = projectDiagnosticLookup(JSON.parse(raw));
        if (lookup.ref !== ref || lookup.namespace !== namespace) {
          return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE');
        }
        return reply.status(200).header('cache-control', 'no-store').send(lookup);
      } catch {
        if (controller.signal.aborted) return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_TIMEOUT');
        // Oversized, unparseable, too deep, or outside the reviewed shape.
        return fail(reply, 'FERRUM_BFF_DIAGNOSTICS_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        reply.raw.off('close', abandon);
        release(principal.subject);
      }
    },
  );
};

export default diagnosticsPlugin;
