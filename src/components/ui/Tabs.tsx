import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className = "", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    // Scroll horizontally instead of wrapping when many tabs (e.g. TLS) don't
    // fit the viewport.
    className={`flex border-b border-border gap-1 overflow-x-auto overflow-y-hidden ${className}`}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className = "", ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    // Exactly one tab may ever look active. Two rules protect that:
    //
    //  1. No colour transition. Radix flips `data-state` on both tabs in the
    //     same commit, so the underline moves instantly while a transitioned
    //     text colour would fade — leaving the outgoing tab still orange for
    //     ~150ms next to the already-orange incoming tab.
    //  2. Hover is scoped to `data-[state=inactive]`, so hovering the active
    //     tab can never repaint it with the inactive colour regardless of how
    //     the generated `hover:` / `data-[state=active]:` rules end up ordered.
    //
    // The focus indicator is an inset ring (not the global orange outline) so
    // a focused-but-inactive tab can't be mistaken for a second active tab.
    className={`px-4 py-2 text-sm font-medium whitespace-nowrap shrink-0 text-text-secondary data-[state=inactive]:hover:text-text-primary border-b-2 border-transparent cursor-pointer -mb-px rounded-t-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange/40 data-[state=active]:text-orange data-[state=active]:border-orange ${className}`}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className = "", ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={`pt-4 outline-none ${className}`}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
