/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – bind a detail page's editor to one identity       */
/*                                                                    */
/*  See `src/lib/editorIdentity.ts` for the rule this hook enforces.  */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  editorIdentityKey,
  sameEditorIdentity,
  StaleEditorSubmissionError,
  type EditorIdentity,
} from "@/lib/editorIdentity";
import { useNamespace } from "@/stores/namespace";

export interface EditorSession {
  /** The identity this session is bound to. */
  readonly identity: EditorIdentity;
  /**
   * `key` for the editor subtree. Render the editor as
   * `<Editor key={session.key} session={session} />` so it remounts when,
   * and only when, the identity changes.
   */
  readonly key: string;
  /**
   * Wrap a submit or confirm handler so it runs only while the identity it
   * was created under is still the one on screen. A stale invocation calls
   * `onStale` and resolves without running the handler, or rejects with
   * `StaleEditorSubmissionError` when no `onStale` was given.
   *
   * Call `event.preventDefault()` outside the bound handler: a refused
   * submission must still stop the browser's native form submit.
   */
  bind<Args extends unknown[]>(
    handler: (...args: Args) => Promise<void>,
  ): (...args: Args) => Promise<void>;
  /**
   * Whether this session is still the editor on screen: its page is mounted
   * and has not moved to another identity since (returning to the same
   * identity later starts a new session). Check it after an awaited mutation
   * and before any completion-time navigation: a write that started under
   * this editor may finish (and reconcile) after the operator moved to a
   * newer editor, and must not redirect it away.
   */
  isCurrent(): boolean;
}

export interface EditorSessionOptions {
  /**
   * Called instead of throwing when a bound handler is invoked after the
   * identity moved on. Pages use it to explain the discard in a toast.
   */
  onStale?: (captured: EditorIdentity, current: EditorIdentity) => void;
}

/**
 * Resolve the editor identity for `resourceId` under the active namespace.
 *
 * Call this in the component that survives a namespace switch (the route
 * component) and pass the session into the keyed editor. The live identity
 * is tracked here, outside the remounted subtree, so a handler bound by a
 * previous editor instance is measured against what the page shows now.
 */
export function useEditorIdentity(
  resourceId: string,
  options: EditorSessionOptions = {},
): EditorSession {
  const { scope } = useNamespace();
  const namespace = scope.namespace;

  const identity = useMemo<EditorIdentity>(
    () => ({ namespace, resourceId }),
    [namespace, resourceId],
  );

  const live = useRef(identity);
  useEffect(() => {
    live.current = identity;
  }, [identity]);

  const onStaleRef = useRef(options.onStale);
  useEffect(() => {
    onStaleRef.current = options.onStale;
  });

  const bind = useCallback(
    <Args extends unknown[]>(handler: (...args: Args) => Promise<void>) => {
      const captured = identity;
      return async (...args: Args): Promise<void> => {
        const current = live.current;
        if (!sameEditorIdentity(captured, current)) {
          const onStale = onStaleRef.current;
          if (onStale) {
            onStale(captured, current);
            return;
          }
          throw new StaleEditorSubmissionError(captured, current);
        }
        await handler(...args);
      };
    },
    [identity],
  );

  // A session is current only while the hook that issued it is mounted and
  // still holds the very identity it was issued for. Unmounting (the operator
  // opened another family's editor) retires it for good, and so does any
  // identity change: `identity` is a fresh object per change, so leaving and
  // returning to the same namespace/resource does not revive an old session.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isCurrent = useCallback(
    () => mounted.current && live.current === identity,
    [identity],
  );

  return useMemo(
    () => ({ identity, key: editorIdentityKey(identity), bind, isCurrent }),
    [identity, bind, isCurrent],
  );
}
