export const METRICS_REFRESH_INTERVAL_KEY = "ferrum:metricsRefreshInterval";
export const METRICS_LAST_UPDATED_KEY = "ferrum:metricsLastUpdatedAt";
export const DEFAULT_METRICS_REFRESH_INTERVAL = 300_000;

export const METRICS_REFRESH_OPTIONS = [
  { value: "10000", label: "10 seconds" },
  { value: "30000", label: "30 seconds" },
  { value: "60000", label: "1 minute" },
  { value: "120000", label: "2 minutes" },
  { value: "300000", label: "5 minutes" },
  { value: "600000", label: "10 minutes" },
  { value: "0", label: "Manual" },
];

export function getStoredMetricsRefreshInterval(): number {
  try {
    const stored = localStorage.getItem(METRICS_REFRESH_INTERVAL_KEY);
    return stored ? Number(stored) : DEFAULT_METRICS_REFRESH_INTERVAL;
  } catch {
    return DEFAULT_METRICS_REFRESH_INTERVAL;
  }
}

export function setStoredMetricsRefreshInterval(intervalMs: number): void {
  localStorage.setItem(METRICS_REFRESH_INTERVAL_KEY, String(intervalMs));
}

export function getStoredMetricsLastUpdated(): number | undefined {
  try {
    const stored = localStorage.getItem(METRICS_LAST_UPDATED_KEY);
    const timestamp = stored ? Number(stored) : undefined;
    return timestamp && Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

export function setStoredMetricsLastUpdated(timestamp: number): void {
  localStorage.setItem(METRICS_LAST_UPDATED_KEY, String(timestamp));
}
