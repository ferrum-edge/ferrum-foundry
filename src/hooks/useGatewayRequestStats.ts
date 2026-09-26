import { useEffect, useRef, useState } from "react";
import { boundGatewayTarget, isGatewayTargetRetired } from "@/api/gatewayTarget";
import type { AdminMetrics } from "@/api/types";
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
 * Counters are only comparable within one gateway, and the namespace does not
 * identify one (`src/api/gatewayTarget.ts`). So the stored sample names the
 * gateway target it was observed on, and a sample for any other target — or
 * one naming none — is never diffed against. Each namespace keeps a single
 * slot, so the first reading from a new target also replaces the old
 * target's sample: switching back later starts from nothing rather than from
 * a reading taken before the switch.
 */
interface RequestSample {
  target: string;
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

function storageKey(namespace: string): string {
  return `${REQUEST_SAMPLE_STORAGE_KEY}:${namespace}`;
}

function readStoredSample(namespace: string, target: string): RequestSample | undefined {
  try {
    const stored = localStorage.getItem(storageKey(namespace));
    if (!stored) return undefined;

    const parsed = JSON.parse(stored) as RequestSample | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.target !== "string" ||
      parsed.target !== target ||
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
    target,
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

export function useGatewayRequestStats(
  gateway?: AdminMetrics["gateway"],
  dataUpdatedAt?: number,
): GatewayRequestStats {
  const { selectedNamespace } = useNamespace();
  const previousSampleRef = useRef<RequestSample | undefined>(undefined);
  const lastNamespaceRef = useRef(selectedNamespace);
  const [stats, setStats] = useState<GatewayRequestStats>(() => ({
    totalRequests: gateway?.total_requests ?? 0,
  }));

  useEffect(() => {
    // Reset the in-memory sample when the namespace changes so we don't
    // diff counters from two different gateways / namespaces.
    if (lastNamespaceRef.current !== selectedNamespace) {
      previousSampleRef.current = undefined;
      lastNamespaceRef.current = selectedNamespace;
    }

    if (!gateway || !dataUpdatedAt) return;

    // A reading with no bound target, or on a retired page, cannot be
    // attributed to a gateway: show the total but neither diff nor keep it.
    const target = boundGatewayTarget();
    if (!target || isGatewayTargetRetired()) {
      previousSampleRef.current = undefined;
      setStats({ totalRequests: gateway.total_requests });
      return;
    }

    const currentSample = toSample(gateway, dataUpdatedAt, target);
    const storedSample = previousSampleRef.current
      ? undefined
      : readStoredSample(selectedNamespace, target);
    const previousSample =
      previousSampleRef.current ??
      (storedSample && currentSample.timestamp - storedSample.timestamp <= STORED_SAMPLE_MAX_AGE_MS
        ? storedSample
        : undefined);

    setStats(calculateStats(currentSample, previousSample));
    previousSampleRef.current = currentSample;
    writeStoredSample(selectedNamespace, currentSample);
  }, [gateway, dataUpdatedAt, selectedNamespace]);

  return stats;
}
