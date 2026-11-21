/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – reads a mounted page reports inline               */
/* ------------------------------------------------------------------ */

import { useEffect } from "react";
import type { QueryKey } from "@tanstack/react-query";

/**
 * Query keys whose failures a mounted page reports inline (a read notice
 * beside its form), so the global error popup must not report them too.
 *
 * The choice is made per query key at fetch time, not per observer: every
 * observer of one key shares the query, and a refetch (an invalidation, say)
 * runs whichever observer's queryFn the query last stored. A queryFn asks
 * `isInlineReported(key)` and reads silently while the answer is yes.
 */
const registered = new Map<string, number>();

const identity = (key: QueryKey) => JSON.stringify(key);

export function isInlineReported(key: QueryKey): boolean {
  return registered.has(identity(key));
}

/**
 * Report `keys` inline for as long as the calling component is mounted and
 * `active` is true. Pass keys built from stable values; they are compared by
 * content.
 */
export function useInlineReportedReads(keys: readonly QueryKey[], active: boolean): void {
  const ids = keys.map(identity).join("\n");
  useEffect(() => {
    if (!active) return;
    const list = ids.split("\n");
    for (const id of list) registered.set(id, (registered.get(id) ?? 0) + 1);
    return () => {
      for (const id of list) {
        const remaining = (registered.get(id) ?? 1) - 1;
        if (remaining > 0) registered.set(id, remaining);
        else registered.delete(id);
      }
    };
  }, [ids, active]);
}
