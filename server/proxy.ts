import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { fetch, type RequestInit } from 'undici';
import { requireAdminAuth } from './auth.js';
import { loadConfig } from './config.js';
import { generateToken } from './jwt.js';
import { proxyTargetPath, UnsafeProxyPathError } from './proxy-path.js';
import { getDispatcher } from './tls.js';
import { waitingRouteTimeout } from './waitBudget.js';

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const API_SPEC_BODY_LIMIT = 30 * 1024 * 1024;
const RESTORE_BODY_LIMIT = 110 * 1024 * 1024;
const BACKUP_RESTORE_OPERATION_TIMEOUT = 120_000;

const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'content-length',
  'content-type',
  'if-match',
  'if-none-match',
  'prefer',
  'range',
  'x-ferrum-namespace',
] as const;

const RESPONSE_HEADER_ALLOWLIST = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'location',
  'retry-after',
  'x-data-source',
  'x-ferrum-config-cursor',
] as const;

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the permitted route limit');
    this.name = 'PayloadTooLargeError';
  }
}

type UploadTimeoutReason = 'idle' | 'deadline';

class UploadTimeoutError extends Error {
  constructor(readonly reason: UploadTimeoutReason) {
    super(`Request upload exceeded its ${reason} budget`);
    this.name = 'UploadTimeoutError';
  }
}

class GuardedUpload extends Transform {
  private received = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly deadlineTimer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly idleTimeout: number,
    deadline: number,
    private readonly controller: AbortController,
  ) {
    super();
    // Two independent bounds. The idle timer restarts on every chunk and only
    // catches a stalled sender. The deadline timer is armed once here and is
    // never reset, so a body that keeps trickling bytes cannot extend how long
    // it may hold this request, its upstream socket, and its upload permits.
    this.deadlineTimer = setTimeout(() => this.fail('deadline'), deadline);
    this.deadlineTimer.unref();
    this.resetIdleTimer();
    this.once('end', () => this.clearTimers());
    this.once('close', () => this.clearTimers());
    this.once('error', () => this.clearTimers());
  }

  private fail(reason: UploadTimeoutReason): void {
    this.clearTimers();
    const error = new UploadTimeoutError(reason);
    // The controller is the one shared with the undici request, so aborting it
    // cancels the in-flight upstream call as well as this stream.
    this.controller.abort(error);
    this.destroy(error);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail('idle'), this.idleTimeout);
    this.idleTimer.unref();
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    clearTimeout(this.deadlineTimer);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.received += chunk.length;
    if (this.received > this.limit) {
      const error = new PayloadTooLargeError();
      this.controller.abort(error);
      callback(error);
      return;
    }
    this.resetIdleTimer();
    callback(null, chunk);
  }
}

function bodyLimitFor(path: string): number {
  if (path === '/restore') return RESTORE_BODY_LIMIT;
  if (path === '/api-specs' || path.startsWith('/api-specs/')) return API_SPEC_BODY_LIMIT;
  return DEFAULT_BODY_LIMIT;
}

function carriesRequestBody(request: FastifyRequest): boolean {
  const method = request.method;
  return method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
}

function isLargeUpload(request: FastifyRequest): boolean {
  if (!carriesRequestBody(request)) return false;
  return bodyLimitFor(proxyTargetPath(request)) > DEFAULT_BODY_LIMIT;
}

function copyRequestHeaders(request: FastifyRequest, authorization: string): Record<string, string> {
  // Undici transparently decodes compressed fetch responses while preserving
  // the upstream content-length. Prefer an identity response so downstream
  // framing describes the bytes Foundry actually streams.
  const headers: Record<string, string> = { authorization, 'accept-encoding': 'identity' };
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value) && value[0]) headers[name] = value[0];
  }
  return headers;
}

function timeoutResponse(phase: string, reason?: UploadTimeoutReason) {
  return {
    error: 'Gateway Timeout',
    code: 'FERRUM_BFF_TIMEOUT',
    phase,
    ...(reason && { reason }),
  };
}

function safeResponseHeader(name: string, value: string, upstream: URL): string | undefined {
  if (name !== 'location') return value;
  try {
    const location = new URL(value, upstream);
    if (location.origin !== upstream.origin) return undefined;
    return `/api/proxy${location.pathname}${location.search}`;
  } catch {
    return undefined;
  }
}

const proxyPlugin: FastifyPluginAsync = async (fastify) => {
  // This encapsulated parser passes the incoming stream to the route. Auth in
  // onRequest runs before parsing, and the route forwards exact bytes instead
  // of materializing and re-serializing large JSON/YAML documents.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  // Every proxied request that carries a body occupies a socket and an upstream
  // connection for as long as the body takes to arrive, so the global pool
  // bounds all of them. The large-upload pool is a stricter inner bound on the
  // routes whose bodies may be tens of megabytes.
  let activeUploads = 0;
  let activeLargeUploads = 0;
  const reservedUploads = new WeakSet<FastifyRequest>();
  const reservedLargeUploads = new WeakSet<FastifyRequest>();

  const reserveUpload = async (request: FastifyRequest, reply: Parameters<typeof requireAdminAuth>[1]) => {
    if (!carriesRequestBody(request)) return;
    const config = loadConfig();
    if (activeUploads >= config.maxActiveUploads) {
      return reply.status(429).header('retry-after', '1').send({
        error: 'Too Many Requests',
        code: 'FERRUM_BFF_UPLOAD_CAPACITY',
        scope: 'all',
      });
    }
    if (isLargeUpload(request)) {
      if (activeLargeUploads >= config.maxLargeUploads) {
        return reply.status(429).header('retry-after', '1').send({
          error: 'Too Many Requests',
          code: 'FERRUM_BFF_UPLOAD_CAPACITY',
          scope: 'large',
        });
      }
      activeLargeUploads += 1;
      reservedLargeUploads.add(request);
    }
    activeUploads += 1;
    reservedUploads.add(request);
  };

  // Both releases are keyed off a WeakSet membership test, so a request that
  // holds one or both permits gives back exactly what it took, exactly once,
  // whichever of the two terminal hooks fires.
  const releaseUpload = (request: FastifyRequest) => {
    if (reservedLargeUploads.delete(request)) {
      activeLargeUploads = Math.max(0, activeLargeUploads - 1);
    }
    if (reservedUploads.delete(request)) {
      activeUploads = Math.max(0, activeUploads - 1);
    }
  };

  fastify.addHook('onResponse', async (request) => releaseUpload(request));
  fastify.addHook('onRequestAbort', async (request) => releaseUpload(request));

  const requireSafeProxyPath = async (
    request: FastifyRequest,
    reply: Parameters<typeof requireAdminAuth>[1],
  ) => {
    try {
      proxyTargetPath(request);
    } catch (error) {
      if (error instanceof UnsafeProxyPathError) {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'FERRUM_BFF_UNSAFE_PATH',
        });
      }
      throw error;
    }
  };

  fastify.all('/api/proxy/*', {
    onRequest: [requireAdminAuth, requireSafeProxyPath, reserveUpload],
    bodyLimit: RESTORE_BODY_LIMIT,
  }, async (request, reply) => {
    const config = loadConfig();
    const principal = request.authPrincipal;
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });

    const targetPath = proxyTargetPath(request);
    const target = new URL(config.adminUrl);
    target.pathname = targetPath;
    const queryIndex = request.url.indexOf('?');
    if (queryIndex >= 0) target.search = request.url.slice(queryIndex + 1);

    const declaredLength = Number(request.headers['content-length']);
    const routeBodyLimit = bodyLimitFor(targetPath);
    if (Number.isFinite(declaredLength) && declaredLength > routeBodyLimit) {
      return reply.status(413).send({
        error: 'Payload Too Large',
        code: 'FERRUM_BFF_BODY_LIMIT',
        limit: routeBodyLimit,
      });
    }

    const controller = new AbortController();
    let timeoutPhase = 'response';
    const waitTimeout = waitingRouteTimeout(request.method, targetPath);
    const responseTimeout = targetPath === '/restore' || (request.method === 'GET' && targetPath === '/backup')
      ? Math.max(config.readTimeout, BACKUP_RESTORE_OPERATION_TIMEOUT)
      : Math.max(config.readTimeout, waitTimeout);
    let responseTimer: NodeJS.Timeout | undefined;
    const clearResponseDeadline = () => {
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = undefined;
    };
    const startResponseDeadline = () => {
      if (responseTimer) return;
      timeoutPhase = 'response';
      responseTimer = setTimeout(() => {
        controller.abort(new Error('Response deadline exceeded'));
      }, responseTimeout);
      responseTimer.unref();
    };

    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) controller.abort(new Error('Downstream client disconnected'));
    };
    reply.raw.once('close', abortOnDisconnect);

    try {
      const token = await generateToken(config, principal);
      const method = request.method;
      const hasBody = carriesRequestBody(request);
      let body: GuardedUpload | undefined;
      if (hasBody && request.body && typeof (request.body as NodeJS.ReadableStream).pipe === 'function') {
        timeoutPhase = 'upload';
        // The large-upload routes get their own, longer wall-clock budget. A
        // 2 MiB body has no business outlasting the write timeout, so ordinary
        // routes reuse it as their absolute budget as well as their idle one.
        const uploadDeadline = routeBodyLimit > DEFAULT_BODY_LIMIT
          ? config.uploadTimeout
          : config.writeTimeout;
        body = (request.body as Readable).pipe(
          new GuardedUpload(routeBodyLimit, config.writeTimeout, uploadDeadline, controller),
        );
        body.once('end', startResponseDeadline);
      } else {
        startResponseDeadline();
      }

      const init: RequestInit = {
        method,
        headers: copyRequestHeaders(request, `Bearer ${token}`),
        body,
        signal: controller.signal,
        dispatcher: getDispatcher(waitTimeout ? { ...config, readTimeout: responseTimeout } : config),
        redirect: 'error',
        ...(body && { duplex: 'half' }),
      };
      const response = await fetch(target, init);
      // An upstream may answer before consuming the entire request body. Once
      // response headers exist, bound the downstream phase immediately.
      startResponseDeadline();

      reply.status(response.status);
      const upstreamEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      const responseWasDecoded = Boolean(upstreamEncoding && upstreamEncoding !== 'identity');
      for (const name of RESPONSE_HEADER_ALLOWLIST) {
        if (name === 'content-length' && responseWasDecoded) continue;
        const value = response.headers.get(name);
        if (value !== null) {
          const safeValue = safeResponseHeader(name, value, target);
          if (safeValue !== undefined) reply.header(name, safeValue);
        }
      }
      if (response.status === 401) reply.header('x-ferrum-auth-layer', 'gateway');

      if (!response.body) {
        clearResponseDeadline();
        return reply.send();
      }

      const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
      const clear = () => {
        clearResponseDeadline();
        reply.raw.off('close', abortOnDisconnect);
      };
      stream.once('end', clear);
      stream.once('close', clear);
      stream.once('error', (error) => {
        clear();
        fastify.log.warn({ code: (error as NodeJS.ErrnoException).code }, 'Upstream response stream failed');
      });
      return reply.send(stream);
    } catch (error: unknown) {
      clearResponseDeadline();
      reply.raw.off('close', abortOnDisconnect);
      if (error instanceof PayloadTooLargeError || controller.signal.reason instanceof PayloadTooLargeError) {
        return reply.status(413).send({ error: 'Payload Too Large', code: 'FERRUM_BFF_BODY_LIMIT' });
      }
      const uploadTimeout = error instanceof UploadTimeoutError
        ? error
        : controller.signal.reason instanceof UploadTimeoutError
          ? controller.signal.reason
          : undefined;
      if (uploadTimeout) {
        // `reason` tells an operator which bound fired: a sender that stopped
        // ("idle") or one that kept trickling past its budget ("deadline").
        return reply.status(504).send(timeoutResponse('upload', uploadTimeout.reason));
      }
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return reply.status(504).send(timeoutResponse(timeoutPhase));
      }
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'UPSTREAM_FAILURE';
      fastify.log.error({ code }, 'Gateway proxy request failed');
      return reply.status(502).send({
        error: 'Bad Gateway',
        code: 'FERRUM_BFF_UPSTREAM_FAILURE',
      });
    }
  });
};

export default proxyPlugin;
