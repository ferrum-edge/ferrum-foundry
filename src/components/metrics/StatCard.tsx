/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Compact metric stat card                          */
/* ------------------------------------------------------------------ */

import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  variant?: "default" | "success" | "warning" | "danger";
  icon?: ReactNode;
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
}: StatCardProps) {
  return (
    <div className="bg-bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-text-secondary text-xs font-medium mb-1">
        {icon && <span className="shrink-0">{icon}</span>}
        <span>{label}</span>
      </div>
      <p className={`text-2xl font-bold ${variantValueClasses[variant]}`}>
        {value}
      </p>
      {subtitle && (
        <p className="text-text-muted text-xs mt-1">{subtitle}</p>
      )}
    </div>
  );
}
