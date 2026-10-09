// The health fields a namespace-scoped principal receives, whichever tier
// Ferrum Edge answers its `ns`-claim JWT with:
// - Edge v0.9.15 and earlier return the detailed view (listeners, data-plane
//   and trust diagnostics, database, cached configuration);
// - Edge v0.9.16+ return the tenant tier (`status`, `ready`, `mode`,
//   `admin_writes_enabled`, and the `namespace` block, which is omitted or has
//   `active` withheld unless the claim covers the active namespace) or the
//   minimal `status` and `ready` probe body.
// Each tier reduces to the same summary, which the capability model reads; a
// field the gateway did not send is simply absent.
const SCOPED_HEALTH_FIELDS = ['status', 'timestamp', 'mode', 'admin_writes_enabled', 'ready'] as const;
const NAMESPACE_BLOCK_FIELDS = ['active', 'serving_scope', 'data_plane_single_namespace'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyScalars(
  source: Record<string, unknown>,
  fields: readonly string[],
  target: Record<string, unknown>,
): void {
  for (const field of fields) {
    const value = source[field];
    if (Object.hasOwn(source, field) && (value === null || typeof value !== 'object')) {
      target[field] = value;
    }
  }
}

/**
 * The `namespace` serving block, kept only when its `active` namespace is one
 * of the principal's grants, as Edge's tenant tier does. When the claim does
 * not cover the served namespace, the tenant tier either omits the block or
 * withholds `active` (absent or `null`); both mean "not served for this
 * session" and drop the whole block. The active namespace name is deployment
 * topology, so a principal not granted it never learns it.
 */
function projectNamespaceBlock(
  value: unknown,
  grants: readonly string[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.active !== 'string' || !grants.includes(value.active)) return undefined;
  const block: Record<string, unknown> = {};
  copyScalars(value, NAMESPACE_BLOCK_FIELDS, block);
  return block;
}

/**
 * Reduce a parsed gateway health body to its summary fields for a principal
 * holding `grants`. Anything that is not a JSON object (an array, `null`, a
 * scalar, or text) has no summary and yields `undefined`.
 */
export function projectHealthSummary(
  parsed: unknown,
  grants: readonly string[],
): Record<string, unknown> | undefined {
  if (!isObject(parsed)) return undefined;
  const summary: Record<string, unknown> = {};
  copyScalars(parsed, SCOPED_HEALTH_FIELDS, summary);
  const namespace = projectNamespaceBlock(parsed.namespace, grants);
  if (namespace) summary.namespace = namespace;
  return summary;
}
