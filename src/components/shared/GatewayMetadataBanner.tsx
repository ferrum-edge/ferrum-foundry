import { useSyncExternalStore } from "react";
import {
  getGatewayMetadataSnapshot,
  subscribeGatewayMetadata,
} from "@/api/gatewayMetadata";

function pathFromUrl(url: string | null): string {
  if (!url) return "configuration request";
  try {
    return new URL(url).pathname;
  } catch {
    return "configuration request";
  }
}

export function GatewayMetadataBanner() {
  const metadata = useSyncExternalStore(
    subscribeGatewayMetadata,
    getGatewayMetadataSnapshot,
    getGatewayMetadataSnapshot,
  );
  const { apply } = metadata;
  if (!metadata.cachedResponse && apply.state === "idle") return null;

  return (
    <div className="mb-4 space-y-2" role="status" aria-live="polite">
      {metadata.cachedResponse && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-text-secondary">
          <strong className="text-warning">Cached gateway data:</strong>{" "}
          {pathFromUrl(metadata.cachedResponse.url)} was served from the in-memory
          cache. It may lag the primary database.
        </div>
      )}
      {apply.state !== "idle" && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm text-text-secondary ${
            apply.state === "applied"
              ? "border-success/40 bg-success/10"
              : apply.state === "nothing_applied"
                ? "border-warning/40 bg-warning/10"
                : apply.state === "pending"
                  ? "border-blue/40 bg-blue/10"
                  : "border-danger/40 bg-danger/10"
          }`}
        >
          {apply.state === "nothing_applied" && (
            <>
              <strong className="text-warning">Change was not committed.</strong>{" "}
              The request was not replayed. Retry manually
              {apply.retryAfter ? ` after at least ${apply.retryAfter} seconds` : " when the gateway is available"}.
            </>
          )}
          {apply.state === "pending" && (
            <>
              <strong className="text-blue">Committed, not yet proven live.</strong>{" "}
              {apply.polling ? "Monitoring" : "Monitoring ended for"} cursor {apply.cursor}.
            </>
          )}
          {apply.state === "applied" && (
            <>
              <strong className="text-success">Configuration is live.</strong>{" "}
              Cursor {apply.cursor} has converged.
            </>
          )}
          {apply.state === "rejected" && (
            <>
              <strong className="text-danger">Committed configuration was rejected by the runtime.</strong>{" "}
              Inspect gateway validation and runtime logs before another change.
            </>
          )}
          {apply.state === "unverifiable" && (
            <>
              <strong className="text-danger">Committed state cannot be verified as live.</strong>{" "}
              Reason: {apply.reason ?? "no apply cursor was available"}. Inspect the live gateway configuration.
            </>
          )}
        </div>
      )}
    </div>
  );
}
