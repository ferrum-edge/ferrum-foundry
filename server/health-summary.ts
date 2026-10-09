// Edge answers the primary-key JWT Foundry signs with its detailed health
// view: listeners, data-plane and trust diagnostics, database, and cached
// configuration. A namespace-scoped principal receives only the summary fields
// below, which the capability model reads.
const SCOPED_HEALTH_FIELDS = ['status', 'timestamp', 'mode', 'admin_writes_enabled', 'ready'] as const;

/**
 * Reduce a parsed gateway health body to its scalar summary fields. Anything
 * that is not a JSON object (an array, `null`, a scalar, or text) has no
 * summary and yields `undefined`.
 */
export function projectHealthSummary(parsed: unknown): Record<string, unknown> | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const summary: Record<string, unknown> = {};
  for (const field of SCOPED_HEALTH_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (Object.hasOwn(parsed, field) && (value === null || typeof value !== 'object')) {
      summary[field] = value;
    }
  }
  return summary;
}
