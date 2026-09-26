import { Socket } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';

// Bounds on discarding an upload the reply no longer needs; see drainUnreadUpload.
const DRAIN_LINGER_MS = 5_000;
const DRAIN_OVERSIZE_LINGER_MS = 1_000;
const DRAIN_BYTE_CAP = 4 * 1024 * 1024;

interface UnreadUpload {
  /** `performance.now()` value past which the request's upload budget is spent. */
  budgetEndsAt: number;
  /** Set when the upload itself ran out of time: its sender gets no further. */
  closeUnread: boolean;
}

const unreadUploads = new WeakMap<FastifyRequest, UnreadUpload>();

/**
 * Give a request the route's own upload budget in place of the default
 * `FERRUM_WRITE_TIMEOUT` one it was admitted with.
 */
export function setUploadBudget(request: FastifyRequest, budgetEndsAt: number): void {
  const state = unreadUploads.get(request);
  if (state) state.budgetEndsAt = budgetEndsAt;
}

/** Close the connection over any unread remainder instead of draining it. */
export function closeUnreadUpload(request: FastifyRequest): void {
  const state = unreadUploads.get(request);
  if (state) state.closeUnread = true;
}

// A reply can go out before its request body has fully arrived: an onRequest
// hook refused it (a 401 before authentication, a 403, an upload-capacity 429),
// the BFF refused it itself (an early 413), or the gateway answered without
// reading it (400/403/412/413, or not at all). The unread remainder then sits
// on the client's socket. Left there, it strands the next keep-alive request
// until the server's request timeout (#418), and Node's own discard reads it
// with no bound but that timeout and no concurrency cap at all (#468). Closing
// the socket over it is no better: unread bytes make the kernel reset the
// connection, which can discard the response before the client reads it and
// fails the client's in-flight write with EPIPE/ECONNRESET (#453). So discard
// the remainder under bounds of our own, so the response arrives and the
// connection stays reusable. A drain never outlives the request's remaining
// upload budget or DRAIN_LINGER_MS, whichever ends first; a remainder larger
// than DRAIN_BYTE_CAP only lingers for DRAIN_OVERSIZE_LINGER_MS, long enough
// for the response to be read. A sender that outlasts its bound, arrives while
// every drain slot is taken, or is still sending when the server begins
// shutting down has its connection closed.
//
// Installed on the root instance, ahead of every other hook, so it covers a
// rejection from any onRequest hook on any route, not only the proxy handler.
export function installUploadDrain(fastify: FastifyInstance): void {
  let activeDrains = 0;
  let closing = false;
  const drainAbandons = new Set<() => void>();

  fastify.addHook('onRequest', async (request, reply) => {
    // A body that has already fully arrived (or never existed) leaves nothing
    // to discard.
    if (request.raw.complete) return;
    const state: UnreadUpload = {
      budgetEndsAt: performance.now() + loadConfig().writeTimeout,
      closeUnread: false,
    };
    unreadUploads.set(request, state);
    reply.raw.once('finish', () => drainUnreadUpload(request, state));
  });

  fastify.addHook('preClose', async () => {
    // A draining connection is not idle, so the HTTP server's close would wait
    // for the drain's own timers and hold shutdown past FERRUM_SHUTDOWN_TIMEOUT.
    closing = true;
    for (const abandon of [...drainAbandons]) abandon();
  });

  const drainUnreadUpload = (request: FastifyRequest, state: UnreadUpload) => {
    const incoming = request.raw;
    const socket = incoming.socket;
    // Assumes HTTP/1.1, which is all the BFF serves: the socket carries only
    // this connection's exchanges. Under HTTP/2 it would be the whole session
    // (the compatibility layer's socket proxy still passes this instanceof
    // check), and destroy() would kill every stream on it. Revisit this before
    // enabling HTTP/2.
    if (incoming.complete || !(socket instanceof Socket) || socket.destroyed) return;
    const config = loadConfig();
    const now = performance.now();
    const lingerFor = Math.min(state.budgetEndsAt - now, DRAIN_LINGER_MS);
    if (state.closeUnread || closing || lingerFor <= 0 || activeDrains >= config.maxActiveUploads) {
      socket.destroy();
      return;
    }
    activeDrains += 1;
    let settled = false;
    let drained = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      activeDrains = Math.max(0, activeDrains - 1);
      drainAbandons.delete(abandon);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (idleTimer) clearTimeout(idleTimer);
      incoming.off('data', onData);
      incoming.off('end', settle);
      incoming.off('error', settle);
      socket.off('close', settle);
    };
    const abandon = () => {
      settle();
      socket.destroy();
    };
    const armDeadline = (ms: number) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(abandon, ms);
      deadlineTimer.unref();
    };
    const idleTimeout = Math.min(config.writeTimeout, lingerFor);
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(abandon, idleTimeout);
      idleTimer.unref();
    };
    let oversize = false;
    const lingerBriefly = () => {
      oversize = true;
      const remaining = lingerFor - (performance.now() - now);
      armDeadline(Math.max(0, Math.min(remaining, DRAIN_OVERSIZE_LINGER_MS)));
    };
    const onData = (chunk: Buffer) => {
      drained += chunk.length;
      if (!oversize && drained > DRAIN_BYTE_CAP) lingerBriefly();
      resetIdleTimer();
    };
    armDeadline(lingerFor);
    // A declared body over the cap may leave a remainder over it too, so treat
    // it as one before the first byte is discarded (the early 413 on a huge
    // declared upload); an undeclared one is caught by the running count.
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > DRAIN_BYTE_CAP) lingerBriefly();
    resetIdleTimer();
    drainAbandons.add(abandon);
    incoming.once('end', settle);
    incoming.once('error', settle);
    socket.once('close', settle);
    // Detach whatever was consuming the body, then let the bytes fall on the
    // floor: a 'data' listener with nowhere to forward them. Node may already
    // have started its own discard, which only resumes the stream; these
    // bounds are what end it.
    incoming.unpipe();
    incoming.on('data', onData);
    incoming.resume();
  };
}
