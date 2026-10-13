/**
 * Failed-authentication throttle for the static login and the trusted-proxy
 * proof check (issue #588).
 *
 * Both compare a caller-supplied value with one static secret, so without a
 * limit anyone who can reach the BFF may guess at full speed. Failures are
 * counted per key (the socket peer address) inside a rolling window: a key is
 * locked out once `maxFailures` of its failures fall within the last
 * `windowMs`, however those failures line up with any earlier ones. While a key
 * is locked out every authentication attempt from it is refused **without
 * comparing the secret**, so a lockout cannot be used to test guesses either.
 * Each further lockout of the same key within its decay period doubles, up to
 * a ceiling.
 *
 * The table of keys is bounded. When it is full of keys that are all locked
 * out, a new key cannot be retained, and dropping it would let every fresh
 * address guess at full speed. Such keys share one overflow entry instead:
 * it counts and locks exactly like a key, and while it is locked every key the
 * table does not hold is refused. That fails closed under an attack spread
 * across more addresses than the table holds, rather than failing open.
 * Addresses that recently proved they hold the secret (the identity proxy, an
 * administrator who signed in) are exempt from the overflow lockout, though
 * never from their own: a flood of fresh addresses cannot lock out the
 * deployment's real users, and only the secret earns the exemption.
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
  /** Keys tracked at once, beyond the shared overflow entry. */
  maxKeys: number;
  /** Recently authenticated keys remembered for the overflow exemption. */
  maxTrustedKeys: number;
  /** Clock, for tests. */
  now?: () => number;
}

interface Entry {
  /** Times of the failures still inside the window, oldest first. */
  failures: number[];
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
  /** Set when the key could not be retained and the overflow entry counted it. */
  overflow?: true;
}

function newEntry(): Entry {
  return { failures: [], lockedUntil: 0, lockouts: 0 };
}

export class AuthFailureThrottle {
  private readonly entries = new Map<string, Entry>();
  private overflow: Entry = newEntry();
  /** Keys that recently proved they hold the secret, least recent first. */
  private readonly trusted = new Set<string>();
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

  /**
   * Milliseconds `key` stays locked out, or `0` when it may try. A key the
   * table does not hold answers for the shared overflow entry, unless it
   * recently authenticated.
   */
  lockedFor(key: string): number {
    if (!this.enabled) return 0;
    const entry = this.entries.get(key) ?? (this.trusted.has(key) ? undefined : this.overflow);
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  /** Count one failed attempt from `key`. */
  recordFailure(key: string): FailureOutcome {
    if (!this.enabled) return { failures: 0 };
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry) {
      // Re-insert so the map stays ordered by last activity for eviction.
      this.entries.delete(key);
    } else {
      entry = newEntry();
    }
    if (this.isStale(entry, now)) entry = newEntry();
    this.entries.set(key, entry);
    this.evict(now, key);
    if (!this.entries.has(key)) {
      // Every retained key is locked out: count it against the overflow entry.
      if (this.isStale(this.overflow, now)) this.overflow = newEntry();
      return { ...this.count(this.overflow, now), overflow: true };
    }
    return this.count(entry, now);
  }

  /**
   * Remember that `key` proved it holds the secret, exempting it from the
   * overflow lockout. Its own failures are kept: see {@link recordSuccess}.
   */
  noteAuthenticated(key: string): void {
    if (!this.enabled) return;
    this.trusted.delete(key);
    this.trusted.add(key);
    for (const oldest of this.trusted) {
      if (this.trusted.size <= this.options.maxTrustedKeys) break;
      this.trusted.delete(oldest);
    }
  }

  /** Forget `key`'s failures after it proved it holds the secret. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
    this.noteAuthenticated(key);
  }

  /** Keys currently tracked, not counting the overflow entry. */
  get size(): number {
    return this.entries.size;
  }

  private count(entry: Entry, now: number): FailureOutcome {
    const { windowMs, maxFailures, lockoutMs, maxLockoutMs } = this.options;
    entry.failures = entry.failures.filter((at) => now - at < windowMs);
    entry.failures.push(now);
    const outcome: FailureOutcome = { failures: entry.failures.length };
    if (entry.failures.length >= maxFailures) {
      const lockout = Math.min(lockoutMs * 2 ** Math.min(entry.lockouts, 30), maxLockoutMs);
      entry.lockouts += 1;
      entry.lockedUntil = now + lockout;
      entry.failures = [];
      outcome.lockedForMs = lockout;
    }
    return outcome;
  }

  /**
   * An entry that is no longer locked, has no failure left in the window, and
   * whose last lockout has decayed carries no information worth keeping.
   */
  private isStale(entry: Entry, now: number): boolean {
    const last = entry.failures.at(-1);
    return (
      entry.lockedUntil <= now &&
      (last === undefined || now - last >= this.options.windowMs) &&
      now - entry.lockedUntil >= this.options.maxLockoutMs
    );
  }

  /**
   * Bring the table back to `maxKeys`: stale keys first, then unlocked ones in
   * least-recently-failed order, `current` (the key being counted) last. A
   * locked key is never dropped, since that would end its lockout early; if
   * only locked keys remain, `current` itself is dropped and the caller counts
   * it against the overflow entry.
   */
  private evict(now: number, current: string): void {
    if (this.entries.size <= this.options.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (key !== current && this.isStale(entry, now)) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxKeys) return;
      if (key !== current && entry.lockedUntil <= now) this.entries.delete(key);
    }
    if (this.entries.size > this.options.maxKeys) {
      const entry = this.entries.get(current);
      // Callers never count a failure for a locked key, but if one did, its
      // lockout must not end early: the table runs one over instead.
      if (entry && entry.lockedUntil <= now) this.entries.delete(current);
    }
  }
}
