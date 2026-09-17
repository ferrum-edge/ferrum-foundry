/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – read-only presentation for unavailable writes     */
/*                                                                     */
/*  A denied write is explained before the user edits anything, and    */
/*  the explanation is always visible text — never only a `disabled`   */
/*  attribute or a tooltip. The server keeps enforcing the same rule;  */
/*  the existing error dialogs still handle genuine surprises.         */
/*                                                                     */
/*  A read-only surface never shows less than the editable one: the    */
/*  disabled fieldset covers the editing controls, while the reasons   */
/*  are wired to the controls they explain with `aria-describedby`     */
/*  because a disabled control is not reachable by keyboard.           */
/* ------------------------------------------------------------------ */

import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import type { CapabilityVerdict } from "@/lib/capabilities";

/**
 * The visible note naming the blocked surface and why.
 *
 * It carries `role="status"` so a denial that appears *after* first paint — the
 * health snapshot resolving mid-session — is announced. A notice already
 * present on first paint is not announced by a live region; it is associated
 * with the surface it covers through `aria-describedby` instead.
 */
export function CapabilityNotice({
  verdict,
  className = "",
  id,
}: {
  verdict?: CapabilityVerdict;
  className?: string;
  /** Set when a control or fieldset points at this notice. */
  id?: string;
}) {
  if (!verdict || verdict.allowed) return null;
  return (
    <div
      role="status"
      id={id}
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
 * spacing is identical in both states. When a caller needs a real box instead,
 * `min-w-0` goes with it: a fieldset inherits the UA `min-width: min-content`,
 * which Tailwind preflight does not reset, and without it a denied surface
 * cannot shrink at phone width where the allowed one can.
 *
 * Only controls belong inside. Anything the denied role may still *read* —
 * collapsible section bodies, a Cancel button — must stay reachable, so a
 * read-only surface is never less informative than the editable one.
 */
export function ReadOnlySurface({
  verdict,
  children,
  noticeClassName = "mb-4",
  contentClassName,
}: {
  verdict?: CapabilityVerdict;
  children: ReactNode;
  noticeClassName?: string;
  /**
   * Layout classes for the fieldset. Pass the stack the children would have
   * received from their parent (`space-y-*`), because `display: contents`
   * keeps the fieldset out of the layout and out of that stack.
   */
  contentClassName?: string;
}) {
  const noticeId = useId();
  if (!verdict || verdict.allowed) return <>{children}</>;
  return (
    <>
      <CapabilityNotice verdict={verdict} className={noticeClassName} id={noticeId} />
      <fieldset
        disabled
        aria-describedby={noticeId}
        className={contentClassName ? `min-w-0 ${contentClassName}` : "contents"}
      >
        {children}
      </fieldset>
    </>
  );
}

/**
 * Present a single unavailable action (a create button, a Delete button) with
 * a short visible reason beside it.
 *
 * The reason is associated with the control through `aria-describedby`, so the
 * two are one announcement rather than two adjacent, unrelated fragments. The
 * full explanation rides along as visually hidden text because the visible
 * summary is only a few words.
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
  const reasonId = useId();
  if (verdict.allowed) return <>{children}</>;
  const described = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": reasonId })
    : children;
  return (
    <div
      className={`flex flex-col gap-1 ${align === "end" ? "items-end text-right" : "items-start text-left"}`}
    >
      <fieldset disabled className="contents">
        {described}
      </fieldset>
      <p
        id={reasonId}
        role="status"
        data-capability-blocked={verdict.blockedBy}
        className="text-xs text-warning max-w-xs"
      >
        {verdict.summary}
        <span className="sr-only">. {verdict.explanation}</span>
      </p>
    </div>
  );
}
