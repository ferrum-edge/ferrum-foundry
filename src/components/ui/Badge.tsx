import { type ReactNode } from "react";

type BadgeVariant =
  | "default"
  | "orange"
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "purple";

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "border border-border text-text-secondary bg-transparent",
  orange: "bg-orange/15 text-orange-light border border-orange/20",
  blue: "bg-blue/15 text-blue-light border border-blue/20",
  green: "bg-success/15 text-success border border-success/20",
  red: "bg-danger/15 text-danger border border-danger/20",
  yellow: "bg-warning/15 text-warning border border-warning/20",
  purple: "bg-purple-500/15 text-purple-400 border border-purple-500/20",
};

export function Badge({
  variant = "default",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 text-xs font-semibold rounded-md ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
