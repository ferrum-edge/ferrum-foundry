/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hook for Namespaces               */
/* ------------------------------------------------------------------ */

import { useQuery } from "@tanstack/react-query";
import * as namespaces from "@/api/namespaces";

export function useNamespaces() {
  return useQuery({
    queryKey: ["namespaces"],
    queryFn: () => namespaces.list(),
    refetchOnWindowFocus: false,
  });
}
