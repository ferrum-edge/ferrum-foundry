/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – cache retirement for cascading mutations         */
/*                                                                    */
/*  Issue #240 established that a deletion must *retire* the scoped   */
/*  detail entry (`removeQueries`), not merely invalidate it: editors */
/*  seed once per identity (`src/lib/editorIdentity.ts`), so a        */
/*  superseded cache entry is what the operator edits and submits.    */
/*                                                                    */
/*  A mutation whose gateway effect cascades across resource *types*  */
/*  — spec import/replace/delete, proxy delete — must retire those    */
/*  other types too. The ids it destroyed are not all known           */
/*  client-side, so retirement is by namespace prefix: over-retiring  */
/*  a detail entry costs a refetch, under-retiring is the defect.     */
/* ------------------------------------------------------------------ */

import type { QueryClient } from "@tanstack/react-query";

/** Detail query-key roots a cascading mutation can destroy. */
export type CascadeKind = "proxy" | "upstream" | "pluginConfig" | "apiSpecDocument";

/** The plural list key that accompanies each detail key. */
const LIST_KEY: Record<CascadeKind, string> = {
  proxy: "proxies",
  upstream: "upstreams",
  pluginConfig: "pluginConfigs",
  apiSpecDocument: "apiSpecs",
};

/**
 * Retire every scoped detail entry of `kinds` in `namespace` and invalidate
 * the matching lists.
 *
 * `namespace` must be the namespace the mutation was *issued* under — carry it
 * through completion (`onMutate` context or the mutation's own result) so a
 * switch after the click cannot retire another tenant's cache.
 */
export function retireCascade(
  qc: QueryClient,
  namespace: string,
  kinds: readonly CascadeKind[],
): void {
  for (const kind of kinds) {
    qc.removeQueries({ queryKey: [kind, namespace] });
    qc.invalidateQueries({ queryKey: [LIST_KEY[kind]] });
  }
}
