/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – seed-once edit baselines                          */
/* ------------------------------------------------------------------ */

import { useRef } from "react";
import type { WriteGuard } from "@/api/conditionalWrite";

export interface EditBaseline<TSeed, TShape> {
  /** The guard for a write issued from this editor, or null before the seed. */
  current: () => WriteGuard<TShape> | null;
  /** Advance the baseline to a canonical accepted response after a save. */
  adopt: (seed: TSeed) => void;
}

/**
 * Capture the content an editor was seeded with, once per editor identity.
 *
 * Forms seed their fields from the first successful read and never rewrite
 * them on a background refetch of the same identity (see
 * `src/lib/editorIdentity.ts`). The baseline a write is judged against must
 * follow the *same* rule: adopting a newer refetch would let the guard pass
 * while the form still holds values from the older read — which is precisely
 * the silent rebase the acceptance criteria forbid.
 *
 * The route renders its editor as `<Editor key={session.key} …>`, so a
 * namespace switch or a different resource remounts this hook and the next
 * successful read seeds a fresh baseline for the new tenant.
 *
 * Only `adopt` moves the baseline, and only with a canonical response the
 * gateway just accepted from this editor.
 */
export function useEditBaseline<TSeed, TShape>(
  seed: TSeed | undefined,
  build: (seed: TSeed) => WriteGuard<TShape>,
): EditBaseline<TSeed, TShape> {
  const guardRef = useRef<WriteGuard<TShape> | null>(null);

  if (guardRef.current === null && seed !== undefined) {
    guardRef.current = build(seed);
  }

  const buildRef = useRef(build);
  buildRef.current = build;

  return {
    current: () => guardRef.current,
    adopt: (next: TSeed) => {
      guardRef.current = buildRef.current(next);
    },
  };
}
