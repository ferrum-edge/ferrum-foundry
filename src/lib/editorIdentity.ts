/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – editor identity                                   */
/* ------------------------------------------------------------------ */

/**
 * Editor identity rule
 * --------------------
 * A detail page's editor — its form fields, credential drafts, inline
 * target editors, and every pending confirmation dialog — is bound to the
 * identity `{ namespace, resourceId }` it was opened for. Two identities
 * are the same only when both parts are equal; a header namespace switch or
 * a route change to another resource is an identity change.
 *
 * The rule has two halves:
 *
 * 1. **Reset on identity change.** The page keys its editor subtree on
 *    `editorIdentityKey()`, so React remounts it when the identity changes
 *    and nothing survives: fields are re-seeded from the new resource, an
 *    open confirmation closes, half-typed credentials are discarded. Nothing
 *    else remounts it — a background refetch, a successful save, or a new
 *    object with the same identity leaves the editor alone.
 *
 * 2. **Refuse stale submissions.** A submit or confirm handler captures the
 *    identity it was created under (`EditorSession.bind`) and is refused if
 *    the page's live identity has moved on by the time it runs. With the
 *    remount above a stale handler is normally unreachable; the guard covers
 *    a closure that outlives its editor (a detached dialog, a queued event).
 *    The gateway request itself is separately pinned to the namespace active
 *    when the mutation started (see `NamespaceScope`), so the two guards
 *    never disagree about where a write goes.
 *
 * Refresh policy for the SAME identity
 * ------------------------------------
 * Fields are seeded once, when the editor mounts for an identity, from the
 * resource as cached at that moment. A background refetch of the same
 * identity never rewrites fields — dirty or clean — so an operator's
 * in-progress edit is never clobbered by a poll or an invalidation. Live
 * data still drives everything outside the fields (the heading, counts,
 * read-only panels), and a successful save leaves the submitted values in
 * place because they are what the gateway now holds. To pick up a change
 * made elsewhere, leave and reopen the resource.
 */
export interface EditorIdentity {
  readonly namespace: string;
  readonly resourceId: string;
}

export function sameEditorIdentity(a: EditorIdentity, b: EditorIdentity): boolean {
  return a.namespace === b.namespace && a.resourceId === b.resourceId;
}

/**
 * React `key` for an editor subtree. It changes when, and only when, the
 * identity changes; observation timestamps and other per-response fields
 * are deliberately not part of it.
 */
export function editorIdentityKey(identity: EditorIdentity): string {
  return JSON.stringify([identity.namespace, identity.resourceId]);
}

export function describeEditorIdentity(identity: EditorIdentity): string {
  return `${identity.resourceId} in namespace ${identity.namespace}`;
}

/** Shown when a bound handler is discarded because its identity moved on. */
export const STALE_EDITOR_MESSAGE =
  "Discarded: the namespace or resource changed before this action ran. " +
  "Review the form and try again.";

/**
 * Thrown by a bound handler that is invoked after the editor's identity has
 * changed, when no `onStale` fallback was configured.
 */
export class StaleEditorSubmissionError extends Error {
  readonly captured: EditorIdentity;
  readonly current: EditorIdentity;

  constructor(captured: EditorIdentity, current: EditorIdentity) {
    super(
      `Refused a submission bound to ${describeEditorIdentity(captured)}; ` +
        `the editor now shows ${describeEditorIdentity(current)}`,
    );
    this.name = "StaleEditorSubmissionError";
    this.captured = captured;
    this.current = current;
  }
}
