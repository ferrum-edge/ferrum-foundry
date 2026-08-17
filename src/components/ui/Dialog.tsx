import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type ReactNode } from "react";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export function DialogContent({
  children,
  className = "",
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full p-6 ${className}`}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors cursor-pointer"
          aria-label="Close"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

interface DialogTitleProps {
  children: ReactNode;
  className?: string;
}

export function DialogTitle({ children, className = "" }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      className={`text-lg font-semibold text-text-primary pr-8 ${className}`}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

interface DialogDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function DialogDescription({
  children,
  className = "",
}: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      className={`text-text-secondary text-sm ${className}`}
    >
      {children}
    </DialogPrimitive.Description>
  );
}
