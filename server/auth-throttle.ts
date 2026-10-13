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
 * The table of keys is bounded, and an entry that still carries anything (a
 * failure inside the window, a lockout, or escalation that has not decayed)
 * is never dropped to make room: dropping it would reset that address, and an
 * attacker cycling through more addresses than the table holds would never be
 * counted. Once the table is full of such entries, every new address shares
 * one overflow entry instead. It counts and locks exactly like a key, and while
 * it is locked every address the table does not hold is refused. That fails
 * closed under an attack spread across more addresses than the table holds.
 *
 * Addresses that recently proved they hold the secret (the identity proxy, an
 * administrator who signed in) keep their own state in a separate bounded
 * table. They are exempt from the overflow lockout, so a flood of fresh
 * addresses cannot lock out the deployment's real users, but never from their
 * own: their failures are counted and locked there whatever the shared table
 * holds. Only the secret earns that exemption.
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
  /** Unauthenticated keys tracked at once, beyond the shared overflow entry. */
  maxKeys: number;
  /** Recently authenticated keys tracked at once, each with its own state. */
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
  /** Addresses that have not authenticated, least recently failed first. */
  private readonly entries = new Map<string, Entry>();
  /**
   * Addresses that recently proved they hold the secret, least recent first,
   * each with its own failure state. Kept apart from {@link entries} so that
   * state is never lost to the capacity of the shared table.
   */
  private readonly trusted = new Map<string, Entry>();
  private readonly overflow: Entry = newEntry();
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
   * Milliseconds `key` stays locked out, or `0` when it may try. An address
   * that recently authenticated answers only for its own state; any other
   * address the table does not hold answers for the shared overflow entry.
   */
  lockedFor(key: string): number {
    if (!this.enabled) return 0;
    const entry = this.trusted.get(key) ?? this.entries.get(key) ?? this.overflow;
    return Math.max(0, entry.lockedUntil - this.now());
  }

  /** Count one failed attempt from `key`. */
  recordFailure(key: string): FailureOutcome {
    if (!this.enabled) return { failures: 0 };
    const now = this.now();
    const trusted = this.trusted.get(key);
    if (trusted) return this.count(this.refresh(trusted, now), now);

    const existing = this.entries.get(key);
    if (existing) {
      // Re-insert so the map stays ordered by last activity.
      this.entries.delete(key);
      const entry = this.refresh(existing, now);
      this.entries.set(key, entry);
      return this.count(entry, now);
    }
    if (this.entries.size >= this.options.maxKeys) this.dropStale(now);
    if (this.entries.size < this.options.maxKeys) {
      const entry = newEntry();
      this.entries.set(key, entry);
      return this.count(entry, now);
    }
    // Every tracked address still carries live failures or a lockout, and
    // dropping one would erase it. Count the newcomer against the overflow.
    return { ...this.count(this.refresh(this.overflow, now), now), overflow: true };
  }

  /**
   * Remember that `key` proved it holds the secret. It moves to the
   * authenticated table, keeping whatever failure state it had, and is exempt
   * from the overflow lockout from then on, never from its own.
   */
  noteAuthenticated(key: string): void {
    if (!this.enabled) return;
    const current = this.trusted.get(key);
    if (current) {
      // Re-insert so the map stays ordered by last authentication.
      this.trusted.delete(key);
      this.trusted.set(key, current);
      return;
    }
    // No room without losing another address's live state: the newcomer
    // keeps whatever it has in the shared table and goes without the
    // exemption until there is.
    if (this.trusted.size >= this.options.maxTrustedKeys && !this.makeTrustedRoom(key)) return;
    const entry = this.entries.get(key) ?? newEntry();
    this.entries.delete(key);
    this.trusted.set(key, entry);
  }

  /**
   * Free one slot in the authenticated table without losing live state: drop
   * the least recently authenticated stale entry, or else demote the least
   * recently authenticated live one into the shared table if it fits there.
   * `newcomer`'s own shared entry is about to move out, so its slot counts as
   * free. Returns whether a slot was freed.
   */
  private makeTrustedRoom(newcomer: string): boolean {
    const now = this.now();
    for (const [key, state] of this.trusted) {
      if (this.isStale(state, now)) {
        this.trusted.delete(key);
        return true;
      }
    }
    const freed = this.entries.has(newcomer) ? 1 : 0;
    if (this.entries.size - freed >= this.options.maxKeys) this.dropStale(now);
    if (this.entries.size - freed >= this.options.maxKeys) return false;
    const oldest = this.trusted.entries().next();
    if (oldest.done) return false;
    const [key, state] = oldest.value;
    this.trusted.delete(key);
    this.entries.set(key, state);
    return true;
  }

  /** Forget `key`'s failures after it proved it holds the secret. */
  recordSuccess(key: string): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.trusted.delete(key);
    this.noteAuthenticated(key);
  }

  /** Addresses tracked in the shared table (not counting authenticated ones). */
  get size(): number {
    return this.entries.size;
  }

  /** `entry`, reset in place when it no longer carries anything worth keeping. */
  private refresh(entry: Entry, now: number): Entry {
    if (this.isStale(entry, now)) Object.assign(entry, newEntry());
    return entry;
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

  /** Drop every stale entry from the shared table; live ones are never dropped. */
  private dropStale(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.isStale(entry, now)) this.entries.delete(key);
    }
  }
}
