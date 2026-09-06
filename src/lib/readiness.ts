import type { BffReadiness } from "@/hooks/useBffHealth";

interface ReadinessObservation {
  data?: BffReadiness;
  isError: boolean;
  isFetching: boolean;
  failureCount: number;
}

export function readinessPresentation(readiness: ReadinessObservation) {
  // A failed background check must override retained successful query data.
  const unreachable = readiness.isError || (readiness.isFetching && readiness.failureCount > 0);
  const status = unreachable ? "unavailable" : (readiness.data?.status ?? "unknown");
  const label = unreachable
    ? "Unreachable"
    : status === "ready" ? "Connected"
      : status === "degraded" ? "Degraded"
        : status === "unavailable" ? "Disconnected" : "Checking";
  const variant = status === "ready" ? "green" as const
    : status === "degraded" ? "yellow" as const
      : status === "unavailable" ? "red" as const : "default" as const;
  return { status, label, variant };
}
