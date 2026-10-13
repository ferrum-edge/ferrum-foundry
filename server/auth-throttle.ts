/**
 * Failed-authentication throttle for the static login and the trusted-proxy
 * proof check (issue #588).
 *
 * Both compare a caller-supplied value with one static secret, so without a
 * limit anyone who can reach the BFF may guess at full speed. Failures are
 * counted per key (the socket peer address) inside a rolling window. When a
 * key reaches the limit it is locked out: every authentication attempt from
 * it is refused **without comparing the secret** until the lockout ends, so a
 * lockout cannot be used to test guesses either. Each further lockout of the
 * same key within its decay period doubles, up to a ceiling.
 *
 * State is per process and in memory. Restarting the BFF clears it, which is
 * also how an operator recovers a proxy locked out by a misconfigured secret.
 */

/** Settings for {@link AuthFailureThrottle}. */
export interface AuthThrottleOptions {
  /** Failures within `windowMs` that lock a key out; `0` disables the throttle. */
  maxFailures: number;
  /** The rolling window failures are counted in. */
  windowMs: number;
  /** The first lockout. Each further one doubles it. */
  lockoutMs: number;
  /** The longest lockout, and how long a key stays escalated after its last one. */
  maxLockoutMs: number;
  /** Keys tracked at once; the oldest is dropped beyond this. */
  maxKeys: number;
  /** Clock, for tests. */
  now?: () => number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  /** Lockouts so far; drives the doubling. */
  lockouts: number;
}

/** What {@link AuthFailureThrottle.recordFailure} decided. */
export interface FailureOutcome {
  /** Failures counted in the current window, including this one. */
  failures: number;
  /** Set when this failure started a lockout: how long it lasts. */
  lockedForMs?: number;
}

export class AuthFailureThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly options: AuthThrottleOptions;
  private readonly now: () => number;

  constructor(options: AuthThrottleOptions) {
    this.options = options;
    // Looked up on every call, so a replaced global clock (fake timers) applies.
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.options.maxFailures > 0;
  }

  /** Milliseconds `key` stays locked out, or `0` when it may try. */
  lockedFor(key: string): number {
    if (!this.enabled) return 0;
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.now());
  }

  /** Count one failed attempt from `key`. */
  recordFailure(key: string): FailureOutcome {
    if (!this.enabled) return { failures: 0 };
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && this.isStale(entry, now)) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0, lockouts: 0 };
    } else {
      // Re-insert so the map stays ordered by last activity for eviction.
      this.entries.delete(key);
      if (now - entry.windowStart >= this.options.windowMs) {
        entry.failures = 0;
        entry.windowStart = now;
      }
    }
    entry.failures += 1;
    const outcome: FailureOutcome = { failures: entry.failures };
    if (entry.failures >= this.options.maxFailures) {
      const lockout = Math.min(
        this.options.lockoutMs * 2 ** Math.min(entry.lockouts, 30),
        this.options.maxLockoutMs,
      );
      entry.lockouts += 1;
      entry.lockedUntil = now + lockout;
      entry.failures = 0;
      entry.windowStart = now;
      outcome.lockedForMs = lockout;
    }
    this.entries.set(key, entry);
    this.evict(now);
    return outcome;
  }

  /** Forget `key` after it proved it holds the secret. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Keys currently tracked (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * An entry that is no longer locked, whose window has passed, and whose last
   * lockout has decayed carries no information worth keeping.
   */
  private isStale(entry: Entry, now: number): boolean {
    return (
      entry.lockedUntil <= now &&
      now - entry.windowStart >= this.options.windowMs &&
      now - entry.lockedUntil >= this.options.maxLockoutMs
    );
  }

  private evict(now: number): void {
    if (this.entries.size <= this.options.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (this.isStale(entry, now)) this.entries.delete(key);
    }
    // Still over: drop the least recently failed keys. A locked key is the
    // last thing worth dropping, so unlocked ones go first.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxKeys) return;
      if (entry.lockedUntil <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.options.maxKeys) return;
      this.entries.delete(key);
    }
  }
}
