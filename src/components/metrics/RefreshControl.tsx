/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Refresh interval control bar                      */
/* ------------------------------------------------------------------ */

import { useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";

export interface RefreshControlProps {
  refreshInterval: number;
  onIntervalChange: (ms: number) => void;
  onRefreshNow: () => void;
  lastUpdated?: string;
}

const intervalOptions = [
  { value: "30000", label: "30s" },
  { value: "60000", label: "1m" },
  { value: "300000", label: "5m" },
  { value: "900000", label: "15m" },
  { value: "0", label: "Manual" },
];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
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
}: RefreshControlProps) {
  const agoText = useMemo(
    () => (lastUpdated ? timeAgo(lastUpdated) : undefined),
    [lastUpdated],
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
          options={intervalOptions}
          placeholder="Interval"
        />
      </div>
      <Button variant="secondary" size="sm" onClick={onRefreshNow}>
        Refresh Now
      </Button>
    </div>
  );
}
