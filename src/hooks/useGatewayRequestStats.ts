import { useEffect, useRef, useState } from "react";
import { boundGatewayTarget, isGatewayTargetRetired } from "@/api/gatewayTarget";
import type { AdminMetrics } from "@/api/types";
import { adminMetricsReporting } from "@/lib/adminMetricsReporting";
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
 * Shape version of a stored sample. A sample without it was written before
 * samples carried their mode and may hold a control plane's placeholder zeros,
 * so it is never diffed against.
 */
export const STORED_SAMPLE_VERSION = 2;

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
  timestamp: number;
  uptimeSeconds: number;
  totalRequests: number;
  statusCodeTotals: Record<string, number>;
}

export interface GatewayRequestStats {
  totalRequests: number;
  requestsPerSecond?: number;
  statusCodesPerSecond?: Record<string, number>;
}

/**
 * Latest placeholder (`cp` or `node_agent`) reading this tab observed, per
 * gateway target. `/admin/metrics` describes the whole process, whichever
 * namespace was selected, so one placeholder retires every older baseline
 * at that target, under any namespace. The target names the configured admin URL,
 * not the Edge process behind it, so a data plane that replaces a control
 * plane there looks like the same gateway; a baseline sampled at or before a
 * placeholder may belong to an earlier process and is never bridged from.
 * Module scope, so it survives a route remount; never persisted, so it cannot
 * erase another tab's baseline.
 */
const placeholderSeenAt = new Map<string, number>();

function notePlaceholder(target: string, timestamp: number): void {
  placeholderSeenAt.set(target, Math.max(placeholderSeenAt.get(target) ?? timestamp, timestamp));
}

/** Whether `sample` predates (or is) a placeholder this tab saw at its target. */
function predatesPlaceholder(sample: RequestSample): boolean {
  const seenAt = placeholderSeenAt.get(sample.target);
  return seenAt !== undefined && sample.timestamp <= seenAt;
}

/** Test-only reset of the tab's placeholder observations. */
export function resetPlaceholderObservations(): void {
  placeholderSeenAt.clear();
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
    uptimeSeconds: gateway.uptime_seconds,
    totalRequests: gateway.total_requests,
    statusCodeTotals: gateway.status_codes_total,
  };
}

function calculateStats(
  current: RequestSample,
  previous?: RequestSample,
): GatewayRequestStats {
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

  const statusCodesPerSecond: Record<string, number> = {};
  for (const [code, total] of Object.entries(current.statusCodeTotals)) {
    const previousTotal = previous.statusCodeTotals[code] ?? 0;
    statusCodesPerSecond[code] = Math.max(0, total - previousTotal) / elapsedSeconds;
  }

  return {
    totalRequests: current.totalRequests,
    requestsPerSecond:
      (current.totalRequests - previous.totalRequests) / elapsedSeconds,
    statusCodesPerSecond,
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
      candidate && !predatesPlaceholder(candidate) ? candidate : undefined;

    const { requestsPerSecond, statusCodesPerSecond } = calculateStats(currentSample, previousSample);
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
