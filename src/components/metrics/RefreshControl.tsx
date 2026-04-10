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
  isRefreshing?: boolean;
}

function timeAgo(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
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
  isRefreshing = false,
}: RefreshControlProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const agoText = useMemo(
    () => (lastUpdated ? timeAgo(lastUpdated) : undefined),
    [lastUpdated, now],
  );

  return (
    <div className="flex items-center gap-3">
      {agoText && (
        <span className="text-text-muted text-xs whitespace-nowrap">
          Last updated: {agoText}
        </span>
      )}
      <div className="w-28">
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
