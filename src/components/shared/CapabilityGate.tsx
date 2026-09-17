/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – read-only presentation for unavailable writes     */
/*                                                                     */
/*  A denied write is explained before the user edits anything, and    */
/*  the explanation is always visible text — never only a `disabled`   */
/*  attribute or a tooltip. The server keeps enforcing the same rule;  */
/*  the existing error dialogs still handle genuine surprises.         */
/* ------------------------------------------------------------------ */

import type { ReactNode } from "react";
import type { CapabilityVerdict } from "@/lib/capabilities";

/**
 * The visible note. Rendered as a status region so assistive technology
 * announces it with the surface rather than only on a failed submit.
 */
export function CapabilityNotice({
  verdict,
  className = "",
}: {
  verdict: CapabilityVerdict;
  className?: string;
}) {
  if (verdict.allowed) return null;
  return (
    <div
      role="status"
      data-capability-blocked={verdict.blockedBy}
      className={`rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 ${className}`}
    >
      <p className="text-sm font-medium text-warning">{verdict.headline}</p>
      <p className="text-xs text-text-muted mt-1">{verdict.explanation}</p>
    </div>
  );
}

/**
 * Present a whole editing surface read-only. A `disabled` fieldset disables
 * every form control it contains, including those inside the nested form, so
 * a large form becomes non-editable without touching each field — but the
 * note above it, not the disabled state, is what tells the user why.
 *
 * `display: contents` keeps the fieldset out of the layout so surrounding
 * spacing is identical in both states.
 */
export function ReadOnlySurface({
  verdict,
  children,
  noticeClassName = "mb-4",
  contentClassName,
}: {
  verdict: CapabilityVerdict;
  children: ReactNode;
  noticeClassName?: string;
  /**
   * Layout classes for the fieldset. Pass the stack the children would have
   * received from their parent (`space-y-*`), because `display: contents`
   * keeps the fieldset out of the layout and out of that stack.
   */
  contentClassName?: string;
}) {
  if (verdict.allowed) return <>{children}</>;
  return (
    <>
      <CapabilityNotice verdict={verdict} className={noticeClassName} />
      <fieldset disabled className={contentClassName ?? "contents"}>
        {children}
      </fieldset>
    </>
  );
}

/**
 * Present a single unavailable action (a create button, a Delete button) with
 * a short visible reason beside it.
 */
export function WriteAction({
  verdict,
  children,
  align = "end",
}: {
  verdict: CapabilityVerdict;
  children: ReactNode;
  align?: "start" | "end";
}) {
  if (verdict.allowed) return <>{children}</>;
  return (
    <div
      className={`flex flex-col gap-1 ${align === "end" ? "items-end text-right" : "items-start text-left"}`}
    >
      <fieldset disabled className="contents">
        {children}
      </fieldset>
      <p
        role="status"
        data-capability-blocked={verdict.blockedBy}
        className="text-xs text-warning max-w-xs"
        title={verdict.explanation}
      >
        {verdict.summary}
      </p>
    </div>
  );
}
