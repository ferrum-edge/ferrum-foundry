/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – request rates from two /admin/metrics samples     */
/* ------------------------------------------------------------------ */

// Imports nothing, so the mock admin gateway's tests can load it in Node.

/** Counters read from one `/admin/metrics` response. */
export interface CounterSample {
  /** The gateway target the response came from. */
  target: string;
  /** Its `gateway.mode`. */
  mode: string;
  /** When the response arrived (ms). */
  timestamp: number;
  uptimeSeconds: number;
  totalRequests: number;
  statusCodeTotals: Record<string, number>;
}

export interface RequestRates {
  totalRequests: number;
  requestsPerSecond?: number;
  statusCodesPerSecond?: Record<string, number>;
}

/**
 * Slack allowed between a sample pair's wall-clock gap and the gateway's
 * uptime advance. Edge serves `/admin/metrics` from a process-wide cache of
 * up to 5 s, so either snapshot can be that stale (5 s each), uptime is
 * whole seconds (1 s), and each timestamp is when the response arrived, not
 * when Edge read its clock (transport jitter): 12 s, or 20% of a long gap.
 */
const UPTIME_TOLERANCE_MIN_SECONDS = 12;
const UPTIME_TOLERANCE_RATIO = 0.2;

/**
 * Rates between `previous` and `current`, or the total alone when the two
 * are not comparable counters of one process.
 */
export function calculateRequestRates(current: CounterSample, previous?: CounterSample): RequestRates {
  if (
    !previous ||
    previous.target !== current.target ||
    previous.mode !== current.mode ||
    current.timestamp <= previous.timestamp ||
    current.uptimeSeconds < previous.uptimeSeconds ||
    current.totalRequests < previous.totalRequests
  ) {
    return { totalRequests: current.totalRequests };
  }

  const elapsedSeconds = (current.timestamp - previous.timestamp) / 1000;
  if (elapsedSeconds <= 0) {
    return { totalRequests: current.totalRequests };
  }

  // One process's uptime advances with the wall clock. When it does not, the
  // two samples came from different processes at the same target (a restart,
  // or a replacement behind the same admin URL), whose counters are not
  // comparable, even if the newer process has run longer or served more.
  const uptimeDrift = Math.abs(current.uptimeSeconds - previous.uptimeSeconds - elapsedSeconds);
  const tolerance = Math.max(UPTIME_TOLERANCE_MIN_SECONDS, elapsedSeconds * UPTIME_TOLERANCE_RATIO);
  if (uptimeDrift > tolerance) {
    return { totalRequests: current.totalRequests };
  }

  const statusCodesPerSecond: Record<string, number> = {};
  for (const [code, total] of Object.entries(current.statusCodeTotals)) {
    const previousTotal = previous.statusCodeTotals[code] ?? 0;
    statusCodesPerSecond[code] = Math.max(0, total - previousTotal) / elapsedSeconds;
  }

  return {
    totalRequests: current.totalRequests,
    requestsPerSecond: (current.totalRequests - previous.totalRequests) / elapsedSeconds,
    statusCodesPerSecond,
  };
}
