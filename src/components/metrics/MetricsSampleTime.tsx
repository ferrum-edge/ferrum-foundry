/** Timestamp belongs to this query's successful observation, never a sibling. */
export function MetricsSampleTime({ timestamp }: { timestamp: number }) {
  return (
    <p className="text-text-muted text-xs mb-3">
      {timestamp > 0 ? <>Last successful sample: <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleString()}</time></> : "No successful sample yet."}
    </p>
  );
}
