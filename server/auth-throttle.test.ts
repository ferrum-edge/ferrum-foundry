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

  it('bounds the keys it tracks, keeping locked keys longest', () => {
    const { instance } = throttle({ maxKeys: 5 });
    for (let i = 0; i < 3; i += 1) instance.recordFailure('locked');
    for (let i = 0; i < 50; i += 1) instance.recordFailure(`key-${i}`);
    expect(instance.size).toBe(5);
    expect(instance.lockedFor('locked')).toBe(1_000);
  });
});
