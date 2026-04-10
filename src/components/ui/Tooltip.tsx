import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

interface TooltipContentProps {
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}

export function TooltipContent({
  children,
  className = "",
  side = "top",
  sideOffset = 6,
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={sideOffset}
        className={`z-50 bg-bg-card border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary shadow-xl data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 ${className}`}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-bg-card" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
