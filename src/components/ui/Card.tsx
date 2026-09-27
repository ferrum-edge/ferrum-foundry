import { forwardRef, type HTMLAttributes } from "react";

type CardPadding = "none" | "compact" | "default";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
  /**
   * Inner spacing. Use `"none"` for a card whose content (a table, a list of
   * rows) supplies its own gutters. A `p-*` class in `className` cannot do
   * this: Tailwind orders utilities by value, not by class-list position, so
   * the default `p-6` would win over a caller's `p-0`.
   */
  padding?: CardPadding;
}

const paddingClasses: Record<CardPadding, string> = {
  none: "",
  compact: "p-3",
  default: "p-5 sm:p-6",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ hoverable = false, padding = "default", className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`bg-bg-card border border-border rounded-xl ${paddingClasses[padding]} ${hoverable ? "hover:bg-bg-card-hover hover:-translate-y-0.5 transition-all duration-200 cursor-pointer" : ""} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = "Card";
