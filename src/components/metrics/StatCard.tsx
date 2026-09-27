/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Compact metric stat card                          */
/* ------------------------------------------------------------------ */

import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  /** Colour the value only when it encodes a status; plain values stay neutral. */
  variant?: "default" | "success" | "warning" | "danger";
  icon?: ReactNode;
  className?: string;
}

const variantValueClasses: Record<NonNullable<StatCardProps["variant"]>, string> = {
  default: "text-text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function StatCard({
  label,
  value,
  subtitle,
  variant = "default",
  icon,
  className = "",
}: StatCardProps) {
  return (
    <div className={`min-w-0 bg-bg-card border border-border rounded-lg p-4 ${className}`}>
      <div className="flex items-center gap-2 text-text-secondary text-xs font-medium mb-1">
        {icon && <span className="shrink-0 text-text-muted">{icon}</span>}
        <span>{label}</span>
      </div>
      {/* One line: a value such as "392.9 MB" must not break between the
          number and its unit in a narrow card. */}
      <p
        className={`text-2xl font-bold tabular-nums whitespace-nowrap truncate ${variantValueClasses[variant]}`}
        title={String(value)}
      >
        {value}
      </p>
      {subtitle && (
        <p className="text-text-muted text-xs mt-1">{subtitle}</p>
      )}
    </div>
  );
}
