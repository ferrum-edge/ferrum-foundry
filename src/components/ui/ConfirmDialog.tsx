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
}: ConfirmDialogProps) {
  return (
    // While the confirmed action runs, every way out is refused: the answer
    // still belongs to this dialog's flow.
    <Dialog open={open} onOpenChange={(next) => (next || !loading) && onOpenChange(next)}>
      <DialogContent busy={loading}>
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
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
