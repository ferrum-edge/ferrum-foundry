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

  return useMemo(
    () => ({ identity, key: editorIdentityKey(identity), bind }),
    [identity, bind],
  );
}
