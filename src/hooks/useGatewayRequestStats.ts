import { useEffect, useRef, useState } from "react";
import { boundGatewayTarget, isGatewayTargetRetired } from "@/api/gatewayTarget";
import { adminMetricsRequestStart } from "@/api/adminMetricsTiming";
import type { AdminMetrics } from "@/api/types";
import { adminMetricsReporting } from "@/lib/adminMetricsReporting";
import { calculateRequestRates, type RequestRates } from "@/lib/requestRate";
import { useNamespace } from "@/stores/namespace";

const REQUEST_SAMPLE_STORAGE_KEY = "ferrum:metricsRequestSample";
/**
 * A stored sample only bridges a remount (navigating away and back), so the
 * first reading after it is still a recent rate. One from an earlier visit
 * would average over hours and be shown as the current requests per second.
 * The in-memory sample is unaffected: it is always one refresh old.
 */
export const STORED_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/**
 * Shape version of a stored sample. An older sample lacks its mode (and may
 * hold a control plane's placeholder zeros) or its request time, so it is
 * never diffed against.
 */
export const STORED_SAMPLE_VERSION = 3;

/**
 * Counters are only comparable within one gateway, and the namespace does not
 * identify one (`src/api/gatewayTarget.ts`). So the stored sample names the
 * gateway target it was observed on, and a sample for any other target — or
 * one naming none — is never diffed against. Each namespace keeps a single
 * slot, so the first reading from a new target also replaces the old
 * target's sample: switching back later starts from nothing rather than from
 * a reading taken before the switch.
 */
interface RequestSample {
  version: typeof STORED_SAMPLE_VERSION;
  target: string;
  /**
   * The `gateway.mode` the counters were read in. Only a mode that reports
   * proxy runtime is ever sampled, and counters are only diffed within one
   * mode.
   */
  mode: string;
  /** When the response arrived; rates are computed over these. */
  timestamp: number;
  /**
   * When its request was sent. A response can resolve after a later one, so
   * whether a baseline predates a placeholder is judged by this.
   */
  requestedAt: number;
  uptimeSeconds: number;
  totalRequests: number;
  statusCodeTotals: Record<string, number>;
}

export type GatewayRequestStats = RequestRates;

/**
 * Latest placeholder (`cp` or `node_agent`) reading this tab observed, per
 * gateway target. `/admin/metrics` describes the whole process, whichever
 * namespace was selected, so one placeholder retires every older baseline at
 * that target, under any namespace. The target names the configured admin
 * URL, not the Edge process behind it, so a data plane that replaces a
 * control plane there looks like the same gateway; a baseline sampled at or
 * before a placeholder may belong to an earlier process and is never bridged
 * from. Kept in module scope (a route remount) and in `sessionStorage` (a
 * reload of this tab); never in `localStorage`, so it cannot erase another
 * tab's baseline. The uptime check in `calculateStats` catches a replaced
 * process whether or not a placeholder was seen.
 */
const PLACEHOLDER_STORAGE_KEY = "ferrum:metricsPlaceholderSeenAt";
const placeholderSeenAt = new Map<string, number>();

function readStoredPlaceholders(): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PLACEHOLDER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
    );
  } catch {
    return new Map();
  }
}

function setPlaceholder(target: string, seenAt: number): void {
  placeholderSeenAt.set(target, seenAt);
  try {
    const stored = readStoredPlaceholders();
    stored.set(target, seenAt);
    sessionStorage.setItem(PLACEHOLDER_STORAGE_KEY, JSON.stringify(Object.fromEntries(stored)));
  } catch {
    // Ignore storage failures; the in-memory marker and the uptime check remain.
  }
}

function placeholderSeenAtFor(target: string): number | undefined {
  const inMemory = placeholderSeenAt.get(target);
  const stored = readStoredPlaceholders().get(target);
  const seenAt =
    inMemory === undefined ? stored : stored === undefined ? inMemory : Math.max(inMemory, stored);
  // A marker later than now means the clock moved backward since. Clamp it to
  // now: every baseline requested before this moment stays refused, and one
  // requested from now on can bridge without waiting for the clock to catch up.
  const clock = Date.now();
  if (seenAt !== undefined && seenAt > clock) {
    setPlaceholder(target, clock);
    return clock;
  }
  return seenAt;
}

function notePlaceholder(target: string, timestamp: number): void {
  setPlaceholder(target, Math.max(placeholderSeenAtFor(target) ?? timestamp, timestamp));
}

/**
 * Whether `sample` may predate a placeholder this tab saw at its target: its
 * request was sent at or before that placeholder arrived, so the process that
 * answered it may be the one the control plane replaced.
 */
function predatesPlaceholder(sample: RequestSample, seenAt: number | undefined): boolean {
  return seenAt !== undefined && sample.requestedAt <= seenAt;
}

/** Test-only reset of the tab's placeholder observations. */
export function resetPlaceholderObservations(): void {
  placeholderSeenAt.clear();
  try {
    sessionStorage.removeItem(PLACEHOLDER_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

function storageKey(namespace: string): string {
  return `${REQUEST_SAMPLE_STORAGE_KEY}:${namespace}`;
}

function readStoredSample(
  namespace: string,
  target: string,
  mode: string,
): RequestSample | undefined {
  try {
    const stored = localStorage.getItem(storageKey(namespace));
    if (!stored) return undefined;

    const parsed = JSON.parse(stored) as RequestSample | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== STORED_SAMPLE_VERSION ||
      typeof parsed.target !== "string" ||
      parsed.target !== target ||
      typeof parsed.mode !== "string" ||
      parsed.mode !== mode ||
      !adminMetricsReporting(parsed.mode).reportsProxyRuntime ||
      !Number.isFinite(parsed.timestamp) ||
      !Number.isFinite(parsed.requestedAt) ||
      !Number.isFinite(parsed.uptimeSeconds) ||
      !Number.isFinite(parsed.totalRequests)
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function writeStoredSample(namespace: string, sample: RequestSample): void {
  try {
    localStorage.setItem(storageKey(namespace), JSON.stringify(sample));
  } catch {
    // Ignore storage failures; in-memory samples still work in-page.
  }
}

function toSample(
  gateway: AdminMetrics["gateway"],
  timestamp: number,
  target: string,
): RequestSample {
  return {
    version: STORED_SAMPLE_VERSION,
    target,
    mode: gateway.mode,
    timestamp,
    // A reading not fetched by `getAdminMetrics` (seeded into the cache) has
    // no recorded start; its arrival is the latest it can have been sent.
    requestedAt: Math.min(adminMetricsRequestStart(gateway) ?? timestamp, timestamp),
    uptimeSeconds: gateway.uptime_seconds,
    totalRequests: gateway.total_requests,
    statusCodeTotals: gateway.status_codes_total,
  };
}

/**
 * Rates derived from one sample, tagged with what that sample was read from.
 * They are shown only while the current reading has the same mode, namespace
 * and gateway target, so a render that already holds a new gateway's reading
 * (before the effect has sampled it) never shows the previous gateway's rate.
 */
interface SampledRates {
  mode: string;
  namespace: string;
  target: string;
  requestsPerSecond?: number;
  statusCodesPerSecond?: Record<string, number>;
}

export function useGatewayRequestStats(
  gateway?: AdminMetrics["gateway"],
  dataUpdatedAt?: number,
): GatewayRequestStats {
  const { selectedNamespace } = useNamespace();
  const previousSampleRef = useRef<RequestSample | undefined>(undefined);
  const lastNamespaceRef = useRef(selectedNamespace);
  const [rates, setRates] = useState<SampledRates | undefined>(undefined);

  useEffect(() => {
    // Reset the in-memory sample when the namespace changes so we don't
    // diff counters from two different gateways / namespaces.
    if (lastNamespaceRef.current !== selectedNamespace) {
      previousSampleRef.current = undefined;
      lastNamespaceRef.current = selectedNamespace;
    }

    if (!gateway || !dataUpdatedAt) return;

    // A control plane or node agent sends zero placeholders, not counters.
    // Neither diff nor keep them, and drop the in-memory baseline so a later
    // proxy reading starts collecting afresh. The stored sample is left
    // alone: it may be another tab's or target's valid baseline, and it is
    // only ever diffed within its own (proxy) mode and target.
    if (!adminMetricsReporting(gateway.mode).reportsProxyRuntime) {
      previousSampleRef.current = undefined;
      setRates(undefined);
      // Remember it, so neither this nor a remounted view bridges a later
      // proxy reading from a baseline sampled before it.
      const placeholderTarget = boundGatewayTarget();
      if (placeholderTarget && !isGatewayTargetRetired()) {
        notePlaceholder(placeholderTarget, dataUpdatedAt);
      }
      return;
    }

    // A reading with no bound target, or on a retired page, cannot be
    // attributed to a gateway: show the total but neither diff nor keep it.
    const target = boundGatewayTarget();
    if (!target || isGatewayTargetRetired()) {
      previousSampleRef.current = undefined;
      setRates(undefined);
      return;
    }

    // Read (and, after a backward clock correction, clamp) the marker on
    // every proxy reading, so the clamp happens as soon as it is observable.
    const placeholderAt = placeholderSeenAtFor(target);
    const currentSample = toSample(gateway, dataUpdatedAt, target);
    const storedSample = previousSampleRef.current
      ? undefined
      : readStoredSample(selectedNamespace, target, gateway.mode);
    const candidate =
      previousSampleRef.current ??
      (storedSample && currentSample.timestamp - storedSample.timestamp <= STORED_SAMPLE_MAX_AGE_MS
        ? storedSample
        : undefined);
    const previousSample =
      candidate && !predatesPlaceholder(candidate, placeholderAt) ? candidate : undefined;

    const { requestsPerSecond, statusCodesPerSecond } = calculateRequestRates(currentSample, previousSample);
    setRates({ mode: gateway.mode, namespace: selectedNamespace, target, requestsPerSecond, statusCodesPerSecond });
    previousSampleRef.current = currentSample;
    writeStoredSample(selectedNamespace, currentSample);
  }, [gateway, dataUpdatedAt, selectedNamespace]);

  // The total always comes from the reading being rendered, never from an
  // earlier render's state; a placeholder mode reports none.
  const measured = gateway !== undefined && adminMetricsReporting(gateway.mode).reportsProxyRuntime;
  const totalRequests = measured ? gateway.total_requests : 0;
  const target = boundGatewayTarget();
  const current =
    measured &&
    rates !== undefined &&
    rates.mode === gateway.mode &&
    rates.namespace === selectedNamespace &&
    target !== null &&
    rates.target === target &&
    !isGatewayTargetRetired()
      ? rates
      : undefined;

  const stats: GatewayRequestStats = { totalRequests };
  if (current?.requestsPerSecond !== undefined) stats.requestsPerSecond = current.requestsPerSecond;
  if (current?.statusCodesPerSecond !== undefined) stats.statusCodesPerSecond = current.statusCodesPerSecond;
  return stats;
}
