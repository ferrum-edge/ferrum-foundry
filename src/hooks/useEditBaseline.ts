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

/**
 * Reseed an editor after a committed-but-not-live save.
 *
 * The gateway answered `503` with `X-Ferrum-Config-Cursor` or `applied: false`:
 * the draft is durably committed, but no canonical response came back to
 * `adopt`. Keeping the old baseline would make the next Save refuse this
 * operator's own commit as a concurrent edit. Adopting the draft instead is
 * not sound either — a payload spells clears as `null` where a read omits the
 * key, so it never fingerprints like the stored resource.
 *
 * So the form and the baseline are both reseeded from **one** fresh read, the
 * same way an explicit "discard and reload" does. That keeps the seed-once
 * invariant: the baseline only ever describes content the form is showing, so
 * even a writer who committed between this save and the read is displayed,
 * never silently rebased under a stale form. The draft itself is not lost —
 * it is what the gateway now holds.
 *
 * Returns `false`, changing nothing, when that read fails: the form and the
 * old baseline stay, and a further Save is compared against the old baseline,
 * which is the honest outcome when Foundry cannot say what the gateway holds.
 */
export async function reseedAfterCommit<TSeed>(
  refetch: () => Promise<{ data?: TSeed; isError?: boolean }>,
  baseline: Pick<EditBaseline<TSeed, unknown>, "adopt">,
  remount: () => void,
): Promise<boolean> {
  const refreshed = await refetch();
  if (refreshed.isError || refreshed.data === undefined) return false;
  baseline.adopt(refreshed.data);
  remount();
  return true;
}
