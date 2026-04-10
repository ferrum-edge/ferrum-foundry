import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../ui/Dialog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

export interface ErrorPopupProps {
  open: boolean;
  onClose: () => void;
  statusCode?: number;
  body?: string;
  url?: string;
}

function statusBadgeVariant(code?: number) {
  if (!code) return "red" as const;
  if (code >= 500) return "red" as const;
  if (code >= 400) return "yellow" as const;
  return "red" as const;
}

export function ErrorPopup({
  open,
  onClose,
  statusCode,
  body,
  url,
}: ErrorPopupProps) {
  const handleCopy = async () => {
    const text = [
      statusCode && `Status: ${statusCode}`,
      url && `URL: ${url}`,
      body && `\nResponse:\n${body}`,
    ]
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <div className="flex items-center gap-3 mb-4">
          <DialogTitle>API Error</DialogTitle>
          {statusCode && (
            <Badge variant={statusBadgeVariant(statusCode)}>
              {statusCode}
            </Badge>
          )}
        </div>

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

        {body && (
          <div className="mb-4">
            <span className="text-text-muted text-xs font-medium uppercase tracking-wider">
              Response
            </span>
            <pre className="mt-1 bg-code-bg border border-border rounded-lg p-3 text-sm text-text-secondary font-mono overflow-auto max-h-64 whitespace-pre-wrap break-words">
              {body}
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
