import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export interface BffReadiness {
  status: "ready" | "degraded" | "unavailable";
  ready: boolean;
  version: string;
  checkedAt: string;
  components: {
    bff: { status: "ok" };
    gateway: { status: "ok" | "degraded" | "unavailable"; httpStatus?: number };
  };
}

export function useBffReadiness() {
  return useQuery({
    queryKey: ["bff-readiness"],
    queryFn: async () => {
      const response = await api.get("api/health/ready", { throwHttpErrors: false });
      return response.json<BffReadiness>();
    },
    refetchInterval: 15_000,
    retry: false,
    staleTime: 5_000,
  });
}
