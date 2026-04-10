import { type ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-16 px-4 text-center ${className}`}
    >
      {icon && (
        <div className="text-text-muted mb-4 [&_svg]:w-12 [&_svg]:h-12">
          {icon}
        </div>
      )}
      <h3 className="text-text-secondary text-base font-medium">{title}</h3>
      {description && (
        <p className="text-text-muted text-sm mt-1.5 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
