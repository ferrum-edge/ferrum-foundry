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
 * It is **not** a resource revision issued by the gateway. Edge's `ETag`
 * covers the whole stored resource, including fields a write does not replace
 * (plugin associations, or every upstream setting during a targets save), so
 * an editor cannot hold one from the moment it opens without refusing saves
 * that race nothing. The baseline answers "does the gateway still hold what
 * this draft was edited against, on the fields it replaces?"; the tag of the
 * read that answered it, sent as `If-Match`, then makes the write atomic with
 * that answer. On a gateway that issues no tag the comparison alone narrows
 * the race to one round trip. See `docs/concurrent-edits.md`.
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

/**
 * Consumer fields excluded on top of the server-managed set.
 *
 * - `credentials`: a metadata save never sends the editor's credentials; it
 *   takes them from the read it is sent against (`consumers.update`), and
 *   credentials are edited through their own endpoints. A rotation is not
 *   something a metadata draft can revert, and comparing redacted
 *   `[REDACTED]` markers would say nothing anyway.
 * - `labels`: neither the Details form nor the ACL editor sends them, and Edge
 *   preserves the stored map when a `PUT` omits the key. A provisioner
 *   stamping a label cannot be reverted by these saves, so it is not a
 *   conflict — the same reasoning as `plugins` on a proxy.
 */
export const CONSUMER_BASELINE_OMIT: readonly string[] = [
  ...SERVER_MANAGED_FIELDS,
  "credentials",
  "labels",
];

/**
 * Plugin configuration fields excluded on top of the server-managed set.
 * `PluginConfigForm` does not send `labels`, which Edge then preserves (see
 * `CONSUMER_BASELINE_OMIT`). Proxy-group membership lives on the proxies, not
 * here, and the membership plan runs its own per-proxy contract.
 */
export const PLUGIN_BASELINE_OMIT: readonly string[] = [
  ...SERVER_MANAGED_FIELDS,
  "labels",
];

/**
 * Fields a detail-page **delete** leaves out of its comparison (#602).
 *
 * The omissions above are about saves: a `PUT` that omits `plugins`,
 * `credentials`, or `labels` leaves them as they are, so a concurrent change
 * there cannot be lost. A delete destroys the whole resource, those fields
 * included, so it compares everything except the server-managed fields: a
 * plugin attached to a proxy, a credential added to or removed from a
 * consumer, or a label stamped on either since the page loaded refuses the
 * delete. Consumer reads redact credential values, so the comparison sees only
 * what the read shows: each returned type's entries and their count. Neither a
 * same-count rotation nor a change to a type the read omits (`basicauth`,
 * custom types) is visible.
 *
 * Upstreams keep `UPSTREAM_BASELINE_OMIT` for deletes: their omitted fields
 * are written by the mesh control plane, not by a competing operator, and
 * change without one.
 */
export const DELETE_BASELINE_OMIT: readonly string[] = SERVER_MANAGED_FIELDS;

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
  /(secret|password|passphrase|credential|api[_-]?key|client[_-]?key|private[_-]?key|_key$|^key$|token|jwk|hmac|signature|salt|certificate[_-]?pem|_pem$|authorization|cookie|bearer)/i;

/**
 * A `*_path` field usually names where the gateway reads material (a file on
 * its host, a `system://` store, a `k8s://` Secret), not the material itself,
 * and that location is what makes a TLS conflict resolvable, so it is shown.
 * The backend TLS fields also accept the material inline as PEM
 * (`backendTlsReferences.ts`), and an inline private key is the secret itself,
 * so such a field is classified by its value: one carrying the start of PEM
 * armor (`isInlineMaterial`) is redacted like a `*_pem` field.
 */
const MATERIAL_LOCATION_PATTERN = /_paths?$/i;

/**
 * The start of PEM armor: inline certificate or key material, not a location.
 * Deliberately loose. Ferrum Edge reads any value starting `-----BEGIN ` as
 * inline material, and a draft with damaged armor (`-----BEGIN PRIVATE
 * KEY----`) still carries the key bytes, so neither the label nor the closing
 * dashes are required, and a dash or two short still counts.
 */
const INLINE_PEM_PATTERN = /-{3,}\s*BEGIN/i;

function carriesInlinePem(value: unknown): boolean {
  if (typeof value === "string") return INLINE_PEM_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(carriesInlinePem);
  return false;
}

export const REDACTED_PLACEHOLDER = "[redacted]";

export function isRedactedField(field: string): boolean {
  if (MATERIAL_LOCATION_PATTERN.test(field)) return false;
  return REDACTED_FIELD_PATTERN.test(field);
}

/**
 * Whether `value` in a material-location field (`*_path`, `*_paths`) is the
 * material itself, inline PEM, rather than a path or reference to it.
 */
export function isInlineMaterial(field: string, value: unknown): boolean {
  return MATERIAL_LOCATION_PATTERN.test(field) && carriesInlinePem(value);
}

/** Whether `field`'s `value` is hidden: by the field's name, or as inline material. */
export function isRedactedValue(field: string, value: unknown): boolean {
  return isRedactedField(field) || isInlineMaterial(field, value);
}

function redactFieldValue(field: string, value: unknown): unknown {
  if (!isRedactedValue(field, value) || value === null || value === "") return value;
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
  // A plugin `trigger` is redacted as Edge main projects it, then shown with
  // the same nested name rules as any other field.
  const shown = field === "trigger" ? redactPluginTrigger(value) : value;
  if (isRedactedValue(field, shown)) {
    if (shown === null) return "null";
    if (typeof shown === "string" && shown.length === 0) return '""';
    return REDACTED_PLACEHOLDER;
  }
  if (shown === null) return "null";
  if (typeof shown === "string") return shown.length === 0 ? '""' : shown;
  return JSON.stringify(shown, (nestedField, nestedValue) =>
    nestedField === "" ? nestedValue : redactFieldValue(nestedField, nestedValue),
  );
}

/* ------------------------------------------------------------------ */
/*  Plugin execution triggers: Ferrum Edge main's projection           */
/* ------------------------------------------------------------------ */

/**
 * Trigger leaf predicates whose comparison operands are values a client
 * presents (`TRIGGER_CLIENT_FIELD_PREDICATES` in Edge main's
 * `src/admin/plugin_config_projection.rs`, ferrum-edge#7054, after v0.9.20).
 * Whoever knows one can make a plugin instance's trigger fire or not, so a
 * non-admin Edge main read withholds them, and Foundry treats them as secret
 * on every gateway: the pinned v0.9.20 shows a trigger verbatim, but the
 * operands are no less a shared secret there. `scripts/edge-main-drift.mjs`
 * compares this list, and `TRIGGER_VISIBLE_PREDICATES`, with Edge main.
 */
export const TRIGGER_CLIENT_FIELD_PREDICATES: readonly string[] = ["header", "query", "cookie"];

/**
 * Trigger leaf predicates that compare routing facts or authenticated
 * identity and stay readable (`TRIGGER_VISIBLE_PREDICATES` in Edge main;
 * `external_identity` and `external_identity_authority` from ferrum-edge#7417). A
 * leaf key in neither list is not a `PluginTriggerMatch` field, so its value
 * is withheld.
 */
export const TRIGGER_VISIBLE_PREDICATES: readonly string[] = [
  "method",
  "path",
  "host",
  "sni",
  "protocol",
  "source_cidr",
  "namespace",
  "proxy_id",
  "listen_port",
  "consumer",
  "external_identity",
  "external_identity_authority",
  "auth_method",
  "spiffe_id",
];

/** The JSON pointer of a plugin configuration's `trigger`, a sibling of `config`. */
export const PLUGIN_TRIGGER_POINTER = "/trigger";

/** A site of a trigger Edge main's projection withholds wholesale, and what it holds. */
export interface TriggerWithheldSite {
  /** JSON pointer into the plugin body (`/trigger/when/match/header/value/exact/0`). */
  readonly pointer: string;
  readonly value: unknown;
}

function triggerSegment(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isTriggerObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every site of a plugin `trigger` that Edge main's non-admin projection
 * (`project_plugin_trigger_with`) withholds, in the order it visits them:
 * each `exact[]` and `prefix[]` entry, `regex`, and any other operand of a
 * `header`, `query` or `cookie` predicate's `value`. Field names, `presence`,
 * `multi_value`, a boolean `case_insensitive`, the tree structure, and every
 * `TRIGGER_VISIBLE_PREDICATES` leaf stay readable.
 *
 * The walk fails closed as Edge's does: a shape a `PluginTrigger` cannot have
 * (a non-object trigger or one without `when`, a key beside `when`, a
 * non-object node or leaf, a non-array `all` / `any`, a key the schema does
 * not define, a non-object `value`) is one site, withheld whole. A `null` is
 * not a site, since it discloses nothing.
 */
export function pluginTriggerWithheldSites(trigger: unknown): TriggerWithheldSite[] {
  const sites: TriggerWithheldSite[] = [];
  const withhold = (value: unknown, pointer: string) => {
    if (value !== null && value !== undefined) sites.push({ pointer, value });
  };
  const operands = (value: unknown, pointer: string) => {
    if (!isTriggerObject(value)) return withhold(value, pointer);
    for (const [key, operand] of Object.entries(value)) {
      if (key === "case_insensitive" && typeof operand === "boolean") continue;
      const at = `${pointer}/${triggerSegment(key)}`;
      if (Array.isArray(operand)) {
        operand.forEach((item, index) => withhold(item, `${at}/${index}`));
      } else {
        withhold(operand, at);
      }
    }
  };
  const fieldPredicate = (value: unknown, pointer: string) => {
    if (!isTriggerObject(value)) return withhold(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      const at = `${pointer}/${triggerSegment(key)}`;
      if (key === "name" || key === "presence" || key === "multi_value") continue;
      if (key === "value") operands(child, at);
      else withhold(child, at);
    }
  };
  const leaf = (value: unknown, pointer: string) => {
    if (!isTriggerObject(value)) return withhold(value, pointer);
    for (const [key, predicate] of Object.entries(value)) {
      if (TRIGGER_VISIBLE_PREDICATES.includes(key)) continue;
      const at = `${pointer}/${triggerSegment(key)}`;
      if (TRIGGER_CLIENT_FIELD_PREDICATES.includes(key)) fieldPredicate(predicate, at);
      else withhold(predicate, at);
    }
  };
  const node = (value: unknown, pointer: string) => {
    if (!isTriggerObject(value)) return withhold(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      const at = `${pointer}/${triggerSegment(key)}`;
      if ((key === "all" || key === "any") && Array.isArray(child)) {
        child.forEach((item, index) => node(item, `${at}/${index}`));
      } else if (key === "not") {
        node(child, at);
      } else if (key === "match") {
        leaf(child, at);
      } else {
        withhold(child, at);
      }
    }
  };

  if (trigger === null || trigger === undefined) return sites;
  if (!isTriggerObject(trigger) || !("when" in trigger)) {
    withhold(trigger, PLUGIN_TRIGGER_POINTER);
    return sites;
  }
  for (const [key, child] of Object.entries(trigger)) {
    const at = `${PLUGIN_TRIGGER_POINTER}/${triggerSegment(key)}`;
    if (key === "when") node(child, at);
    else withhold(child, at);
  }
  return sites;
}

/** Replace the value at `pointer` (rooted at `/trigger`) inside `root`. */
function replaceAtTriggerPointer(root: { trigger: unknown }, pointer: string, replacement: unknown) {
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let holder: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    holder = (holder as Record<string, unknown>)[segment];
  }
  (holder as Record<string, unknown>)[segments[segments.length - 1]] = replacement;
}

/**
 * `trigger` as a conflict comparison may show it: every site
 * `pluginTriggerWithheldSites` finds replaced by the display marker (an empty
 * string stays visible, as in any redacted field), the rest as it is.
 */
export function redactPluginTrigger(trigger: unknown): unknown {
  const sites = pluginTriggerWithheldSites(trigger);
  if (sites.length === 0) return trigger;
  const root = { trigger: JSON.parse(JSON.stringify(trigger)) as unknown };
  for (const site of sites) {
    if (site.value !== "") replaceAtTriggerPointer(root, site.pointer, REDACTED_PLACEHOLDER);
  }
  return root.trigger;
}
