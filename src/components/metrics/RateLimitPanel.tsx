/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Rate limiting stats panel                         */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { StatCard } from "./StatCard";

interface RateLimitPanelProps {
  rateLimiting: AdminMetrics["rate_limiting"];
}

export function RateLimitPanel({ rateLimiting }: RateLimitPanelProps) {
  return <StatCard label="Tracked Keys" value={rateLimiting.tracked_key_count} />;
}
