import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../ui/Dialog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { UNOBSERVED_OUTCOME_CAUSE, type UnobservedOutcome } from "@/api/mutationOutcome";

export interface ErrorPopupProps {
  open: boolean;
  onClose: () => void;
  statusCode?: number;
  body?: string;
  url?: string;
  /** A write whose answer never arrived: report it as unknown, not failed. */
  outcome?: UnobservedOutcome;
}

function statusBadgeVariant(code?: number) {
  if (!code) return "red" as const;
  if (code >= 500) return "red" as const;
  if (code >= 400) return "yellow" as const;
  return "red" as const;
}

function formatBody(body?: string) {
  if (!body) return "";

  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function ErrorPopup({
  open,
  onClose,
  statusCode,
  body,
  url,
  outcome,
}: ErrorPopupProps) {
  const formattedBody = formatBody(body);

  const handleCopy = async () => {
    const text = [
      outcome && "Outcome unknown: the change may have committed and was not replayed.",
      statusCode && `Status: ${statusCode}`,
      url && `URL: ${url}`,
      formattedBody && `\nResponse:\n${formattedBody}`,
    ]
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <div className="flex items-center gap-3 mb-4">
          <DialogTitle>{outcome ? "Outcome unknown" : "API Error"}</DialogTitle>
          {statusCode && (
            <Badge variant={statusBadgeVariant(statusCode)}>
              {statusCode}
            </Badge>
          )}
        </div>

        {outcome && (
          <p className="mb-3 text-sm text-text-secondary">
            {UNOBSERVED_OUTCOME_CAUSE[outcome.reason]} The gateway may already
            have committed this change. Foundry did not replay it. Re-read the
            current configuration before retrying.
          </p>
        )}

        {url && (
          <div className="mb-3">
            <span className="text-text-muted text-xs font-medium uppercase tracking-wider">
              URL
            </span>
            <p className="text-text-secondary text-sm mt-1 break-all font-mono">
              {url}
            </p>
          </div>
        )}

        {formattedBody && (
          <div className="mb-4">
            <span className="text-text-muted text-xs font-medium uppercase tracking-wider">
              Response
            </span>
            <pre className="mt-1 bg-code-bg border border-border rounded-lg p-3 text-sm text-text-secondary font-mono overflow-auto max-h-64 whitespace-pre-wrap break-words">
              {formattedBody}
            </pre>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={handleCopy}>
            Copy Error
          </Button>
          <Button variant="primary" onClick={onClose}>
            Dismiss
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
