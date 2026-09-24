import { MutationCache, QueryClient } from "@tanstack/react-query";
import { isCommittedWrite, isUnobservedWrite } from "@/api/client";

export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    // A write whose answer was lost may have committed, and a write answered
    // with the committed-but-not-live 503 certainly did. Either way cached
    // reads no longer describe the gateway, so they are refreshed and the
    // operator decides from real gateway state; the write itself is never
    // replayed. A committed write raises no error popup (`src/api/client.ts`):
    // the live-apply banner reports it.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isUnobservedWrite(error) || isCommittedWrite(error)) {
          void queryClient.invalidateQueries();
        }
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
