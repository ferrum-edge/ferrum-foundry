import type { ReactNode } from "react";
import { Card } from "./Card";

const minimumWidths = {
  "40rem": "min-w-[40rem]",
  "48rem": "min-w-[48rem]",
  "52rem": "min-w-[52rem]",
};

/**
 * The header row of a resource grid: flush with the top of its card, with a
 * tinted background like a data-table header. Combine with the grid template.
 */
export const GRID_HEADER_CLASS =
  "px-4 py-2.5 items-center border-b border-border bg-bg-primary/60 text-text-muted text-xs font-semibold uppercase tracking-wider";

/**
 * A body row. Every cell starts at the top of the row, and the row sets the
 * text-sm line box, so a one-line cell, a lone badge, and the first line of a
 * two-line cell sit on the same line instead of the badge dropping to the
 * baseline of a taller default line.
 */
export const GRID_ROW_CLASS = "px-4 py-3 items-start text-sm";

interface ResourceGridProps {
  label: string;
  children: ReactNode;
  emptyState?: ReactNode;
  minWidth?: keyof typeof minimumWidths;
}

/** Keep headers and rows on one scrollable canvas when the card is narrow. */
export function ResourceGrid({
  label,
  children,
  emptyState,
  minWidth = "52rem",
}: ResourceGridProps) {
  return (
    <Card padding="none" className="min-w-0 max-w-full overflow-hidden">
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange/40"
      >
        <div className={`w-full ${minimumWidths[minWidth]}`}>{children}</div>
      </div>
      {emptyState}
    </Card>
  );
}
