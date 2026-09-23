import { MutationCache, QueryClient } from "@tanstack/react-query";
import { isUnobservedWrite } from "@/api/client";

export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    // A write whose answer was lost may have committed. Cached reads are
    // refreshed so the operator decides from real gateway state; the write
    // itself is never replayed.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isUnobservedWrite(error)) void queryClient.invalidateQueries();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 300_000,
      },
    },
  });
  return queryClient;
}
