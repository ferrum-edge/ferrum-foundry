import { useState, type ReactNode } from "react";

export interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  badge?: string;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border/50 py-4">
      <button
        type="button"
        className="flex items-center justify-between w-full text-left cursor-pointer group"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary group-hover:text-orange transition-colors">
            {title}
          </h3>
          {badge && (
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-orange/15 text-orange-light border border-orange/20">
              {badge}
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </div>
  );
}
