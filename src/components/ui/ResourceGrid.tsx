import type { ReactNode } from "react";
import { Card } from "./Card";

const minimumWidths = {
  "40rem": "min-w-[40rem]",
  "48rem": "min-w-[48rem]",
  "52rem": "min-w-[52rem]",
};

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
    <Card className="min-w-0 max-w-full overflow-hidden p-0">
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
