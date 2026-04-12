import { useEffect, useRef, useState } from "react";
import type { AdminMetrics } from "@/api/types";
import { useNamespace } from "@/stores/namespace";

const REQUEST_SAMPLE_STORAGE_KEY = "ferrum:metricsRequestSample";

interface RequestSample {
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

function readStoredSample(namespace: string): RequestSample | undefined {
  try {
    const stored = localStorage.getItem(storageKey(namespace));
    if (!stored) return undefined;

    const parsed = JSON.parse(stored) as RequestSample;
    if (
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
): RequestSample {
  return {
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

    const currentSample = toSample(gateway, dataUpdatedAt);
    const previousSample =
      previousSampleRef.current ?? readStoredSample(selectedNamespace);

    setStats(calculateStats(currentSample, previousSample));
    previousSampleRef.current = currentSample;
    writeStoredSample(selectedNamespace, currentSample);
  }, [gateway, dataUpdatedAt, selectedNamespace]);

  return stats;
}
