import { useQuery } from "@tanstack/react-query";
import { api, SILENT_ERRORS } from "@/api/client";

/**
 * `GET /api/health/ready`. An unauthenticated caller gets only `status`
 * (`ready` or `unavailable`) and `ready`; the rest needs a session.
 */
export interface BffReadiness {
  status: "ready" | "degraded" | "unavailable";
  ready: boolean;
  version?: string;
  checkedAt?: string;
  components?: {
    bff: { status: "ok" };
    gateway: { status: "ok" | "degraded" | "unavailable"; httpStatus?: number };
  };
}

export function useBffReadiness() {
  return useQuery({
    queryKey: ["bff-readiness"],
    queryFn: async () => {
      const response = await api.get("api/health/ready", { throwHttpErrors: false, context: { [SILENT_ERRORS]: true } });
      return response.json<BffReadiness>();
    },
    refetchInterval: 15_000,
    retry: false,
    staleTime: 5_000,
  });
}
