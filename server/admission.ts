import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Permits held from one admission pool: in total, and per authenticated
 * subject, so a pool can bound both the instance and each identity's share.
 *
 * A request with no subject counts toward the total only. Returning a permit
 * never takes a count below zero, and a subject whose last permit is returned
 * is forgotten, so the map stays bounded by the subjects holding one now.
 */
export class PermitCount {
  #total = 0;
  readonly #bySubject = new Map<string, number>();

  /** Permits held across every subject. */
  get total(): number {
    return this.#total;
  }

  /** Permits `subject` holds. */
  heldBy(subject: string): number {
    return this.#bySubject.get(subject) ?? 0;
  }

  take(subject: string | undefined): void {
    this.#total += 1;
    if (subject !== undefined) this.#bySubject.set(subject, this.heldBy(subject) + 1);
  }

  give(subject: string | undefined): void {
    this.#total = Math.max(0, this.#total - 1);
    if (subject === undefined) return;
    const remaining = (this.#bySubject.get(subject) ?? 1) - 1;
    if (remaining > 0) this.#bySubject.set(subject, remaining);
    else this.#bySubject.delete(subject);
  }
}

/**
 * What each request took from its pools, returned exactly once.
 *
 * `hold` is called once the permits are taken, before a token is signed or the
 * gateway is contacted. From then on `release` gives them back through
 * `onRelease`, at most once per hold, whichever comes first: a Fastify terminal
 * hook (`onResponse`, `onRequestAbort`), the raw response closing, or a socket
 * that had already closed when the permits were taken.
 *
 * Both raw-socket paths matter. A completed request body can lose its response
 * socket without either terminal hook firing, and a socket that closed before
 * the listener existed never emits again. Missing either one leaks the permit,
 * and a leaked per-subject permit shrinks that subject's share until restart.
 */
export class RequestPermits<T> {
  readonly #held = new WeakMap<FastifyRequest, T>();
  readonly #onRelease: (held: T) => void;

  constructor(onRelease: (held: T) => void) {
    this.#onRelease = onRelease;
  }

  hold(request: FastifyRequest, reply: FastifyReply, held: T): void {
    this.#held.set(request, held);
    reply.raw.once('close', () => this.release(request));
    if (reply.raw.destroyed) this.release(request);
  }

  release(request: FastifyRequest): void {
    if (!this.#held.has(request)) return;
    const held = this.#held.get(request) as T;
    this.#held.delete(request);
    this.#onRelease(held);
  }
}
