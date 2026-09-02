/**
 * Shown by the router while a lazily loaded page chunk is still downloading
 * beyond the pending threshold. Kept minimal so a fast navigation never
 * flashes a heavy placeholder.
 */
export function RoutePending() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]" role="status" aria-live="polite">
      <p className="text-sm text-text-muted">Loading…</p>
    </div>
  );
}
