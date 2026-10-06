import type { NamespaceScope } from "@/api/client";
import {
  boundGatewayTarget,
  GatewayTargetChangedError,
  isGatewayTargetRetired,
} from "@/api/gatewayTarget";
import { getBackup } from "@/api/ops";

export interface BackupDownloadCounts {
  proxies: number;
  consumers: number;
}

function completionCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid backup completion count");
  }
  return value;
}

/**
 * An export failure may contain credentials in ky's data, response, message,
 * or request metadata, including a JSON parse error's excerpt. Their values
 * are unknown on a failed read. Keep only the status and fixed diagnostics,
 * never the original error, headers, body, stack, or cause.
 */
function safeExportFailure(error: unknown): Error {
  const source = error instanceof Error ? (error as Error & { response?: Response }) : undefined;
  const status = source?.response?.status;
  const response =
    typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? new Response(null, { status })
      : undefined;
  const name = source?.name;
  const message =
    name === "GatewayTargetChangedError"
      ? "Backup export refused because the gateway target was replaced. Reload Foundry."
      : name === "TimeoutError"
        ? "Backup export timed out. Try the download again."
        : response
          ? `Backup export failed (HTTP ${response.status}). Try the download again.`
          : "Backup download failed. Try the download again.";
  const safe = new Error(message);
  safe.name = response
    ? "HTTPError"
    : name === "GatewayTargetChangedError" || name === "TimeoutError"
      ? name
      : "BackupDownloadError";
  if (response) Object.defineProperty(safe, "response", { value: response, enumerable: true });
  return safe;
}

/** Download the deliberate unredacted archive without returning it to Query. */
export async function downloadBackup(
  scope: NamespaceScope,
  resources?: string[],
): Promise<BackupDownloadCounts> {
  const namespace = scope.namespace;
  const gatewayTarget = boundGatewayTarget();
  try {
    const data = await getBackup({ namespace }, resources);
    // The page never adopts a successor gateway. Also refuse a late answer
    // after another response retired this target, before publishing a file.
    if (
      isGatewayTargetRetired() ||
      (gatewayTarget !== null && boundGatewayTarget() !== gatewayTarget)
    ) {
      throw new GatewayTargetChangedError("/api/proxy/backup");
    }
    const counts = {
      proxies: completionCount(data.counts.proxies),
      consumers: completionCount(data.counts.consumers),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ferrum-backup-${namespace}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      // Let the browser begin the download from the blob URL before releasing
      // it: revoking synchronously after click can cancel a large export.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    return counts;
  } catch (error) {
    throw safeExportFailure(error);
  }
}
