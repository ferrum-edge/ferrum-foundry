/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Refresh interval control bar                      */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { METRICS_REFRESH_OPTIONS } from "@/utils/metricsRefresh";

export interface RefreshControlProps {
  refreshInterval: number;
  onIntervalChange: (ms: number) => void;
  onRefreshNow: () => void | Promise<void>;
  lastUpdated?: string;
  lastUpdatedLabel?: string;
  isRefreshing?: boolean;
}

function timeAgo(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function RefreshControl({
  refreshInterval,
  onIntervalChange,
  onRefreshNow,
  lastUpdated,
  lastUpdatedLabel = "Last updated",
  isRefreshing = false,
}: RefreshControlProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const agoText = useMemo(
    () => (lastUpdated ? timeAgo(lastUpdated, now) : undefined),
    [lastUpdated, now],
  );

  return (
    <div className="flex min-w-0 flex-col flex-wrap items-stretch gap-3 sm:flex-row sm:items-center">
      {agoText && (
        <span className="text-text-muted text-xs sm:whitespace-nowrap">
          {lastUpdatedLabel}: {agoText}
        </span>
      )}
      <div className="w-full min-w-0 sm:w-28">
        <Select
          value={String(refreshInterval)}
          onValueChange={(v) => onIntervalChange(Number(v))}
          options={METRICS_REFRESH_OPTIONS}
          placeholder="Interval"
        />
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={isRefreshing}
        onClick={() => {
          void onRefreshNow();
        }}
      >
        {isRefreshing ? "Refreshing..." : "Refresh Now"}
      </Button>
    </div>
  );
}
