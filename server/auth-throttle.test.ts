import { describe, expect, it } from 'vitest';
import { AuthFailureThrottle, type AuthThrottleOptions } from './auth-throttle.js';

function throttle(overrides: Partial<AuthThrottleOptions> = {}) {
  let now = 1_000_000;
  const instance = new AuthFailureThrottle({
    maxFailures: 3,
    windowMs: 10_000,
    lockoutMs: 1_000,
    maxLockoutMs: 4_000,
    maxKeys: 100,
    maxTrustedKeys: 10,
    now: () => now,
    ...overrides,
  });
  return { instance, advance: (ms: number) => { now += ms; } };
}

describe('AuthFailureThrottle', () => {
  it('locks a key out once it reaches the failure limit inside the window', () => {
    const { instance } = throttle();
    expect(instance.recordFailure('a')).toEqual({ failures: 1 });
    expect(instance.recordFailure('a')).toEqual({ failures: 2 });
    expect(instance.lockedFor('a')).toBe(0);
    expect(instance.recordFailure('a')).toEqual({ failures: 3, lockedForMs: 1_000 });
    expect(instance.lockedFor('a')).toBe(1_000);
    expect(instance.lockedFor('b')).toBe(0);
  });

  it('counts a rolling window, not a fixed one', () => {
    const { instance, advance } = throttle({ windowMs: 10_000, maxFailures: 3 });
    instance.recordFailure('a'); // t = 0
    advance(9_000);
    instance.recordFailure('a'); // t = 9 s
    advance(1_000);
    // t = 10 s: the first failure has left the window, the second has not.
    expect(instance.recordFailure('a')).toEqual({ failures: 2 });
    advance(100);
    expect(instance.recordFailure('a')).toEqual({ failures: 3, lockedForMs: 1_000 });
  });

  it('forgets failures older than the window', () => {
    const { instance, advance } = throttle();
    instance.recordFailure('a');
    instance.recordFailure('a');
    advance(10_000);
    expect(instance.recordFailure('a')).toEqual({ failures: 1 });
    expect(instance.lockedFor('a')).toBe(0);
  });

  it('doubles each further lockout up to the ceiling, then decays', () => {
    const { instance, advance } = throttle();
    const lockOut = () => {
      instance.recordFailure('a');
      instance.recordFailure('a');
      return instance.recordFailure('a').lockedForMs;
    };
    expect(lockOut()).toBe(1_000);
    advance(1_000);
    expect(lockOut()).toBe(2_000);
    advance(2_000);
    expect(lockOut()).toBe(4_000);
    advance(4_000);
    expect(lockOut()).toBe(4_000);
    // Quiet for longer than the window and the ceiling: back to the first step.
    advance(4_000 + 10_000);
    expect(lockOut()).toBe(1_000);
  });

  it('clears a key on success', () => {
    const { instance } = throttle();
    instance.recordFailure('a');
    instance.recordFailure('a');
    instance.recordSuccess('a');
    expect(instance.recordFailure('a')).toEqual({ failures: 1 });
  });

  it('does nothing when disabled', () => {
    const { instance } = throttle({ maxFailures: 0 });
    for (let i = 0; i < 50; i += 1) instance.recordFailure('a');
    expect(instance.lockedFor('a')).toBe(0);
    expect(instance.size).toBe(0);
  });

  it('never drops a live key to make room; newcomers count against the overflow', () => {
    const { instance } = throttle({ maxKeys: 5 });
    for (let i = 0; i < 3; i += 1) instance.recordFailure('locked');
    for (let i = 0; i < 50; i += 1) instance.recordFailure(`key-${i}`);
    expect(instance.size).toBe(5);
    expect(instance.lockedFor('locked')).toBe(1_000);
    // key-0..key-3 hold the remaining slots with one live failure each.
    expect(instance.recordFailure('key-0')).toEqual({ failures: 2 });
    // The other 46 shared the overflow, which locked on its third.
    expect(instance.lockedFor('key-49')).toBeGreaterThan(0);
  });

  it('makes room by dropping only stale keys', () => {
    const { instance, advance } = throttle({ maxKeys: 1 });
    instance.recordFailure('old');
    advance(10_000 + 4_000);
    expect(instance.recordFailure('new')).toEqual({ failures: 1 });
    expect(instance.size).toBe(1);
  });
});

describe('AuthFailureThrottle overflow', () => {
  it('refuses an attacker who cycles through more addresses than the table holds', () => {
    const { instance } = throttle({ maxKeys: 1, maxFailures: 3 });
    let refused = false;
    for (let i = 0; i < 20 && !refused; i += 1) {
      const key = i % 2 === 0 ? 'A' : 'B';
      if (instance.lockedFor(key) > 0) refused = true;
      else instance.recordFailure(key);
    }
    expect(refused).toBe(true);
    expect(instance.lockedFor('A')).toBeGreaterThan(0);
    expect(instance.lockedFor('B')).toBeGreaterThan(0);
  });

  it('keeps throttling new keys once the table is full of locked keys', () => {
    const { instance } = throttle({ maxKeys: 1 });
    for (let i = 0; i < 3; i += 1) instance.recordFailure('A');
    expect(instance.lockedFor('A')).toBe(1_000);

    expect(instance.recordFailure('B')).toEqual({ failures: 1, overflow: true });
    expect(instance.recordFailure('B')).toEqual({ failures: 2, overflow: true });
    expect(instance.recordFailure('B')).toEqual({ failures: 3, lockedForMs: 1_000, overflow: true });
    expect(instance.lockedFor('B')).toBe(1_000);
    expect(instance.lockedFor('A')).toBe(1_000);
    // Every other untracked key shares the overflow lockout.
    expect(instance.lockedFor('C')).toBe(1_000);
    expect(instance.size).toBe(1);
  });

  it('exempts authenticated keys from the overflow lockout, never from their own', () => {
    const { instance } = throttle({ maxKeys: 1 });
    instance.noteAuthenticated('proxy');
    for (let i = 0; i < 3; i += 1) instance.recordFailure('A');
    for (let i = 0; i < 3; i += 1) instance.recordFailure('B');
    expect(instance.lockedFor('C')).toBe(1_000);
    expect(instance.lockedFor('proxy')).toBe(0);

    // Saturated as it is, the table still counts and locks the proxy itself.
    expect(instance.recordFailure('proxy')).toEqual({ failures: 1 });
    instance.recordFailure('proxy');
    expect(instance.recordFailure('proxy')).toEqual({ failures: 3, lockedForMs: 1_000 });
    expect(instance.lockedFor('proxy')).toBe(1_000);
  });

  it('keeps failures an address had before it authenticated', () => {
    const { instance } = throttle();
    instance.recordFailure('proxy');
    instance.recordFailure('proxy');
    instance.noteAuthenticated('proxy');
    expect(instance.recordFailure('proxy')).toEqual({ failures: 3, lockedForMs: 1_000 });
  });

  it('bounds the authenticated keys it remembers', () => {
    const { instance } = throttle({ maxKeys: 1, maxTrustedKeys: 2 });
    instance.noteAuthenticated('one');
    instance.noteAuthenticated('two');
    instance.noteAuthenticated('three');
    for (let i = 0; i < 3; i += 1) instance.recordFailure('A');
    for (let i = 0; i < 3; i += 1) instance.recordFailure('B');
    expect(instance.lockedFor('one')).toBe(1_000);
    expect(instance.lockedFor('two')).toBe(0);
    expect(instance.lockedFor('three')).toBe(0);
  });

  it('never discards a locked authenticated address to admit another', () => {
    const { instance } = throttle({ maxKeys: 1, maxTrustedKeys: 1 });
    instance.noteAuthenticated('A');
    for (let i = 0; i < 3; i += 1) instance.recordFailure('A');
    instance.recordFailure('B'); // fills the shared table with live state
    instance.noteAuthenticated('C');
    expect(instance.lockedFor('A')).toBe(1_000);
  });

  it('keeps failures below the threshold when both tables are full', () => {
    const { instance } = throttle({ maxKeys: 1, maxTrustedKeys: 1 });
    instance.noteAuthenticated('A');
    instance.recordFailure('A');
    instance.recordFailure('A');
    instance.recordFailure('B');
    instance.noteAuthenticated('C');
    expect(instance.recordFailure('A')).toEqual({ failures: 3, lockedForMs: 1_000 });
  });

  it('demotes a live authenticated address into the shared table when it fits', () => {
    const { instance } = throttle({ maxKeys: 2, maxTrustedKeys: 1 });
    instance.noteAuthenticated('A');
    instance.recordFailure('A');
    instance.recordFailure('A');
    instance.noteAuthenticated('C');
    expect(instance.size).toBe(1);
    expect(instance.recordFailure('A')).toEqual({ failures: 3, lockedForMs: 1_000 });
    expect(instance.lockedFor('A')).toBe(1_000);
  });
});
