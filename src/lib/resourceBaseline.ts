/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – full-replacement edit baselines                   */
/* ------------------------------------------------------------------ */

/**
 * A *baseline* is the exact content an editor was opened against, reduced to
 * the fields a full-replacement write would actually overwrite. Comparing a
 * baseline against a fresh read immediately before the write is what lets
 * Foundry refuse to submit an older draft over a newer accepted configuration
 * instead of silently reverting it.
 *
 * This module deliberately has no imports. `scripts/concurrent-edit-contract.mjs`
 * loads it directly so the gateway contract exercises the same reduction and
 * the same fingerprint the browser uses, rather than a second copy that can
 * drift from it.
 *
 * ## What a baseline is not
 *
 * It is **not** a resource revision issued by the gateway, and comparing it is
 * **not** a compare-and-swap. Ferrum Edge's admin API has no conditional-write
 * precondition on resource `PUT` (no `If-Match`, no `412`; see
 * `docs/concurrent-edits.md` for the surveyed revision of the spec), so a
 * writer that commits between Foundry's verification read and its `PUT` is
 * still overwritten. The comparison narrows that window from "the whole time
 * an editor is open" — minutes to hours — to one gateway round trip, and it
 * catches an external writer as reliably as another Foundry tab because it
 * compares the gateway's own content rather than local bookkeeping. Closing
 * the remainder requires an Edge precondition contract.
 */

/** A resource reduced to the fields a full-replacement write overwrites. */
export type BaselineSnapshot = Readonly<Record<string, unknown>>;

/**
 * Recursively order object keys so two structurally equal resources serialize
 * identically. Arrays keep their order — element order is meaningful in every
 * resource field Foundry replaces (targets, hosts, allowed methods).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    ordered[key] = canonicalize(record[key]);
  }
  return ordered;
}

/**
 * A deterministic string identity for a baseline snapshot.
 *
 * `undefined` members are dropped by `JSON.stringify`, which is what we want:
 * a payload that omits a key and one that sets it to `undefined` produce the
 * same request bytes, so they must produce the same fingerprint. `null` is a
 * real value (an explicit clear) and is preserved.
 */
export function resourceFingerprint(snapshot: BaselineSnapshot): string {
  return JSON.stringify(canonicalize(snapshot));
}

/**
 * Fields stripped from every baseline because the gateway owns them and a
 * `PUT` never carries them. `updated_at` in particular *must* be excluded:
 * it advances on writes the editor is not competing with, and for namespaces
 * it is an observation timestamp stamped per request (see CLAUDE.md), so
 * including it would manufacture conflicts out of ordinary reads.
 */
export const SERVER_MANAGED_FIELDS: readonly string[] = [
  "created_at",
  "updated_at",
  "namespace",
  "api_spec_id",
];

/**
 * Proxy fields excluded from the baseline on top of the server-managed set.
 *
 * `plugins` is omitted from the write payload by `mergeFormUpdatePayload`, and
 * an omitted `plugins` key tells Edge to preserve the live associations. A
 * membership change made from the plugin pages therefore cannot be lost by a
 * proxy save, so counting it as a conflict would refuse a write that is not
 * in fact racing anything.
 */
export const PROXY_BASELINE_OMIT: readonly string[] = [
  ...SERVER_MANAGED_FIELDS,
  "plugins",
];

/**
 * Upstream fields excluded on top of the server-managed set. These mirror the
 * mesh-owned fields `upstreams.toUpdatePayload` strips: the control plane
 * writes them, an operator save never carries them, and they change without
 * any competing editor.
 */
export const UPSTREAM_BASELINE_OMIT: readonly string[] = [
  ...SERVER_MANAGED_FIELDS,
  "port_overrides",
  "source_locality",
  "source_labels",
  "locality_lb_setting",
  "locality_lb_strict",
];

/** Reduce a fetched resource to the fields a full-replacement write replaces. */
export function baselineSnapshot(
  resource: object,
  omit: readonly string[],
): BaselineSnapshot {
  const record = resource as Record<string, unknown>;
  const excluded = new Set(omit);
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (excluded.has(key)) continue;
    snapshot[key] = record[key];
  }
  return snapshot;
}

/** Baseline fingerprint for a fetched resource. */
export function baselineFingerprint(
  resource: object,
  omit: readonly string[],
): string {
  return resourceFingerprint(baselineSnapshot(resource, omit));
}

/**
 * Reduce a resource to named fields only.
 *
 * Used by writes that replace one field rather than the whole resource: the
 * upstream targets editor sends only `targets`, so only `targets` can be lost
 * to a concurrent editor. Comparing the whole upstream there would refuse a
 * target add merely because this same operator saved the settings tab — the
 * same-client composition `upstreams.updateTargets` exists to support.
 */
export function pickSnapshot(
  resource: object,
  fields: readonly string[],
): BaselineSnapshot {
  const record = resource as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) snapshot[field] = record[field];
  return snapshot;
}

/* ------------------------------------------------------------------ */
/*  Field-level comparison for the conflict dialog                     */
/* ------------------------------------------------------------------ */

export interface BaselineFieldDifference {
  readonly field: string;
  /** The value the editor was opened against. */
  readonly original: unknown;
  /** The value the gateway holds now, written by someone else. */
  readonly current: unknown;
  /** The value this editor is trying to write. */
  readonly proposed: unknown;
  /** True when another writer changed this field since the editor opened. */
  readonly changedUpstream: boolean;
  /** True when this editor changed this field. */
  readonly changedLocally: boolean;
}

/**
 * Value equality for the *display* comparison only.
 *
 * An absent key and an explicit `null` are treated as the same side here. A
 * proposed payload spells its clears out as `null` (see
 * `proxies.mergeFormUpdatePayload`) while a gateway response simply omits an
 * unset optional, so without this every editor would open its conflict dialog
 * on a page of fields nobody touched. The guard itself does not use this: it
 * compares two gateway reads of the same shape via `resourceFingerprint`.
 */
function sameValue(a: unknown, b: unknown): boolean {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  return resourceFingerprint({ v: left }) === resourceFingerprint({ v: right });
}

/**
 * Compare the three sides of a conflict field by field, keeping only fields
 * where at least one side disagrees. Fields nobody touched are noise in a
 * dialog whose whole job is to show the operator what is actually at stake.
 */
export function compareBaselines(
  original: BaselineSnapshot,
  current: BaselineSnapshot,
  proposed: BaselineSnapshot,
): BaselineFieldDifference[] {
  const fields = [
    ...new Set([
      ...Object.keys(original),
      ...Object.keys(current),
      ...Object.keys(proposed),
    ]),
  ].sort();

  const differences: BaselineFieldDifference[] = [];
  for (const field of fields) {
    const changedUpstream = !sameValue(original[field], current[field]);
    const changedLocally = !sameValue(original[field], proposed[field]);
    if (!changedUpstream && !changedLocally) continue;
    differences.push({
      field,
      original: original[field],
      current: current[field],
      proposed: proposed[field],
      changedUpstream,
      changedLocally,
    });
  }
  return differences;
}

/**
 * Fields whose *values* are never rendered in a conflict comparison.
 *
 * A conflict dialog is a place where two operators' configuration meets on one
 * screen, so it fails closed on anything that could carry credential or trust
 * material rather than trying to recognise individual secret-bearing fields.
 * The field *name* and whether it changed are still shown — that is what makes
 * the conflict actionable — but the value is replaced.
 */
const REDACTED_FIELD_PATTERN =
  /(secret|password|passphrase|credential|api[_-]?key|client[_-]?key|private[_-]?key|_key$|^key$|token|jwk|hmac|signature|salt|certificate[_-]?pem|_pem$)/i;

/**
 * A `*_path` field names a file on the gateway host, not the material in it.
 * Redacting it would hide the one thing that makes a TLS conflict resolvable
 * while protecting nothing: the gateway never returns key bytes on these
 * resources, only the paths it was told to read.
 */
const MATERIAL_LOCATION_PATTERN = /_paths?$/i;

export const REDACTED_PLACEHOLDER = "[redacted]";

export function isRedactedField(field: string): boolean {
  if (MATERIAL_LOCATION_PATTERN.test(field)) return false;
  return REDACTED_FIELD_PATTERN.test(field);
}

function redactFieldValue(field: string, value: unknown): unknown {
  if (!isRedactedField(field) || value === null || value === "") return value;
  return REDACTED_PLACEHOLDER;
}

/**
 * Render one side of a field comparison for display. Redacted fields collapse
 * to a marker that still distinguishes "set", "cleared", and "absent", because
 * an operator resolving a conflict needs to know a credential field moved even
 * though they must not be shown what it moved to.
 */
export function formatBaselineValue(field: string, value: unknown): string {
  if (value === undefined) return "—";
  if (isRedactedField(field)) {
    if (value === null) return "null";
    if (typeof value === "string" && value.length === 0) return '""';
    return REDACTED_PLACEHOLDER;
  }
  if (value === null) return "null";
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  return JSON.stringify(value, (nestedField, nestedValue) =>
    nestedField === "" ? nestedValue : redactFieldValue(nestedField, nestedValue),
  );
}
