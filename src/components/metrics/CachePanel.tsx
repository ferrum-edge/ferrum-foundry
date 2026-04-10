/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Cache stats panel                                 */
/* ------------------------------------------------------------------ */

import type { AdminMetrics } from "@/api/types";
import { StatCard } from "./StatCard";

interface CachePanelProps {
  caches: AdminMetrics["caches"];
}

export function CachePanel({ caches }: CachePanelProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <StatCard label="Prefix Cache Entries" value={caches.router.prefix_cache_entries} />
      <StatCard label="Regex Cache Entries" value={caches.router.regex_cache_entries} />
      <StatCard label="Prefix Evictions" value={caches.router.prefix_eviction_count} />
      <StatCard label="Regex Evictions" value={caches.router.regex_eviction_count} />
      <StatCard label="Max Cache Entries" value={caches.router.max_cache_entries} />
      <StatCard label="DNS Cache Entries" value={caches.dns.cache_entries} />
    </div>
  );
}
