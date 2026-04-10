import { forwardRef, type HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ hoverable = false, className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`bg-bg-card border border-border rounded-xl p-6 ${hoverable ? "hover:bg-bg-card-hover hover:-translate-y-0.5 transition-all duration-200 cursor-pointer" : ""} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = "Card";
