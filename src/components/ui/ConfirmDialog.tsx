import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./Dialog";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: "danger" | "primary";
  onConfirm: () => void;
  loading?: boolean;
  /**
   * The confirmed action's request is in flight, so the dialog refuses to
   * close. Defaults to `loading`; pass it separately when `loading` also
   * covers something that is not this dialog's request, such as a refetch.
   */
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  variant = "danger",
  onConfirm,
  loading = false,
  busy = loading,
}: ConfirmDialogProps) {
  return (
    // While the confirmed action runs, every way out is refused: the answer
    // still belongs to this dialog's flow.
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent busy={busy}>
        <DialogTitle>{title}</DialogTitle>
        {description && (
          <DialogDescription className="mt-2">
            {description}
          </DialogDescription>
        )}
        <div className="flex justify-end gap-3 mt-6">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={loading || busy}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            onClick={onConfirm}
            loading={loading}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
