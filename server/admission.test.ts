import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PermitCount, RequestPermits } from './admission.js';

function request(): FastifyRequest {
  return {} as FastifyRequest;
}

/** A reply whose raw response can close, or have closed already. */
function reply(destroyed = false): { reply: FastifyReply; raw: EventEmitter & { destroyed: boolean } } {
  const raw = Object.assign(new EventEmitter(), { destroyed });
  return { reply: { raw } as unknown as FastifyReply, raw };
}

describe('PermitCount', () => {
  it('counts the total and each subject share independently', () => {
    const count = new PermitCount();
    count.take('a');
    count.take('a');
    count.take('b');
    count.take(undefined);
    expect(count.total).toBe(4);
    expect(count.heldBy('a')).toBe(2);
    expect(count.heldBy('b')).toBe(1);
    expect(count.heldBy('c')).toBe(0);

    count.give('a');
    count.give(undefined);
    expect(count.total).toBe(2);
    expect(count.heldBy('a')).toBe(1);
    expect(count.heldBy('b')).toBe(1);
  });

  it('forgets a subject whose last permit is returned and never goes below zero', () => {
    const count = new PermitCount();
    count.take('a');
    count.give('a');
    expect(count.heldBy('a')).toBe(0);
    // A spurious extra return neither underflows nor resurrects the subject.
    count.give('a');
    count.give(undefined);
    expect(count.total).toBe(0);
    expect(count.heldBy('a')).toBe(0);
    count.take('a');
    expect(count.heldBy('a')).toBe(1);
    expect(count.total).toBe(1);
  });
});

describe('RequestPermits', () => {
  it('returns a held permit exactly once across raw close, terminal hooks, and repeats', () => {
    const onRelease = vi.fn();
    const permits = new RequestPermits<string>(onRelease);
    const held = request();
    const { reply: heldReply, raw } = reply();

    permits.hold(held, heldReply, 'subject-a');
    expect(onRelease).not.toHaveBeenCalled();

    // The raw close alone returns it: a completed body can lose its socket
    // without either terminal hook firing.
    raw.emit('close');
    expect(onRelease).toHaveBeenCalledTimes(1);
    permits.release(held); // onResponse
    permits.release(held); // onRequestAbort
    raw.emit('close');
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith('subject-a');
  });

  it('returns the permit when a terminal hook fires before the socket closes', () => {
    const onRelease = vi.fn();
    const permits = new RequestPermits<{ large: boolean }>(onRelease);
    const held = request();
    const { reply: heldReply, raw } = reply();

    permits.hold(held, heldReply, { large: true });
    permits.release(held);
    raw.emit('close');
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith({ large: true });
  });

  it('returns a permit taken on a socket that had already closed', () => {
    // Such a socket never emits `close` again: without this the permit leaks
    // and shrinks the subject's share until restart (GHSA-733w follow-up).
    const onRelease = vi.fn();
    const permits = new RequestPermits<string>(onRelease);
    const held = request();
    const { reply: closedReply, raw } = reply(true);

    permits.hold(held, closedReply, 'subject-a');
    expect(onRelease).toHaveBeenCalledTimes(1);
    permits.release(held);
    raw.emit('close');
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('releases nothing for a request that holds nothing', () => {
    const onRelease = vi.fn();
    const permits = new RequestPermits<string>(onRelease);
    permits.release(request());
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('keeps each request permit separate', () => {
    const count = new PermitCount();
    const permits = new RequestPermits<string>((subject) => count.give(subject));
    const first = request();
    const second = request();
    const firstReply = reply();
    const secondReply = reply();

    count.take('a');
    permits.hold(first, firstReply.reply, 'a');
    count.take('a');
    permits.hold(second, secondReply.reply, 'a');
    expect(count.heldBy('a')).toBe(2);

    firstReply.raw.emit('close');
    expect(count.heldBy('a')).toBe(1);
    expect(count.total).toBe(1);
    permits.release(first);
    expect(count.heldBy('a')).toBe(1);
    expect(count.total).toBe(1);

    permits.release(second);
    expect(count.heldBy('a')).toBe(0);
    expect(count.total).toBe(0);
  });
});
