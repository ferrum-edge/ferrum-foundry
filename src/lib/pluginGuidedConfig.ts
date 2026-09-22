/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – guided plugin configuration state                 */
/* ------------------------------------------------------------------ */

/**
 * Reading a configuration into guided fields, validating it, and writing the
 * edits back **without losing anything the descriptors do not model**.
 *
 * The invariants this module exists to keep:
 *
 * - **Unmodelled keys round-trip.** A newer gateway field, or one this
 *   reduction deliberately leaves out, is carried through untouched. An older
 *   structured view must never silently strip a config it does not understand.
 * - **Omission is a value.** A field the configuration does not set stays
 *   unset; an explicit `null` stays `null`. Both are distinct from an empty
 *   string, and full-replacement admission treats them differently.
 * - **Order is preserved.** Keys keep their position so a JSON ↔ guided ↔ JSON
 *   round trip of an untouched config is byte-identical.
 * - **Client validation is assistance.** It reports what the schema states;
 *   the gateway still decides admission, and a prerequisite only the
 *   deployment can satisfy is reported as unknown, never as met.
 */

import type { JsonValue } from "./pluginConfigDefaults";
import type { GuidedField, GuidedSection, PluginGuidedSchema } from "./pluginSchemas";

export type JsonObject = Record<string, JsonValue>;

/** One field's editing state. `present: false` means the key is absent. */
export interface FieldState {
  readonly present: boolean;
  /** Raw editor text. Parsed into JSON by `writeGuidedConfig`. */
  readonly text: string;
  /** Booleans edit as a checkbox rather than text. */
  readonly checked?: boolean;
}

/** `path` is `section.path` + `.` + `field.key`, with `""` for the root. */
export type GuidedValues = Record<string, FieldState>;

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export function fieldPath(section: GuidedSection, field: GuidedField): string {
  return section.path ? `${section.path}.${field.key}` : field.key;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a dotted path such as `limits.0` to the object it names. */
function resolveContainer(root: JsonObject, path: string): JsonObject | undefined {
  if (!path) return root;
  let current: JsonValue | undefined = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return isPlainObject(current) ? current : undefined;
}

function renderValue(field: GuidedField, value: JsonValue): string {
  if (value === null) return "null";
  if (field.kind === "stringList") {
    return Array.isArray(value)
      ? value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")
      : String(value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Read a configuration into guided field state.
 *
 * A secret-bearing field is shown as present-but-blank: the value stays in the
 * configuration and is written back untouched unless the operator types a new
 * one, so editing a rate-limit window never requires re-entering a password
 * and never puts one on screen.
 */
export function readGuidedConfig(
  schema: PluginGuidedSchema,
  config: JsonObject,
): GuidedValues {
  const values: GuidedValues = {};
  for (const section of schema.sections) {
    const container = resolveContainer(config, section.path);
    for (const field of section.fields) {
      const path = fieldPath(section, field);
      const present = container !== undefined && field.key in container;
      const raw = present ? container![field.key] : undefined;
      values[path] = {
        present,
        text: present && !field.secret ? renderValue(field, raw as JsonValue) : "",
        checked: field.kind === "boolean" ? raw === true : undefined,
      };
    }
  }
  return values;
}

function parseValue(field: GuidedField, state: FieldState): JsonValue {
  switch (field.kind) {
    case "boolean":
      return state.checked === true;
    case "integer": {
      const parsed = Number(state.text.trim());
      return Number.isFinite(parsed) ? parsed : state.text.trim();
    }
    case "stringList":
      return state.text
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    default:
      return state.text;
  }
}

function setIn(root: JsonObject, path: string, key: string, value: JsonValue | undefined): void {
  const container = resolveContainer(root, path);
  if (container === undefined) return;
  if (value === undefined) delete container[key];
  else container[key] = value;
}

/**
 * Apply guided edits over the original configuration.
 *
 * Everything starts from a structural copy of the original, so unmodelled
 * keys, their order, and any nesting the descriptors do not reach survive
 * exactly. Only the modelled keys are written or removed.
 *
 * `previous` is the state the values were read from. It is what lets a
 * secret-bearing field distinguish "left alone" (keep the stored value) from
 * "cleared" (remove the key) without ever having displayed it.
 */
export function writeGuidedConfig(
  schema: PluginGuidedSchema,
  original: JsonObject,
  values: GuidedValues,
  previous: GuidedValues,
): JsonObject {
  const next = structuredClone(original) as JsonObject;

  for (const section of schema.sections) {
    if (resolveContainer(next, section.path) === undefined) continue;
    for (const field of section.fields) {
      const path = fieldPath(section, field);
      const state = values[path];
      if (!state) continue;

      if (!state.present) {
        setIn(next, section.path, field.key, undefined);
        continue;
      }

      if (field.secret && state.text.length === 0) {
        // Present, untouched, and never displayed: keep whatever is stored.
        if (previous[path]?.present) continue;
        setIn(next, section.path, field.key, "");
        continue;
      }

      if (state.text.trim() === "null" && field.kind !== "stringList" && field.kind !== "boolean") {
        setIn(next, section.path, field.key, null);
        continue;
      }

      setIn(next, section.path, field.key, parseValue(field, state));
    }
  }

  return next;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

function validateField(
  field: GuidedField,
  state: FieldState,
  path: string,
  seeded: FieldState | undefined,
): FieldIssue | null {
  if (!state.present) {
    if (field.required) {
      return { path, message: `${field.label} is required.` };
    }
    return null;
  }
  if (field.kind === "boolean") return null;

  const text = state.text.trim();

  if (field.kind === "stringList") {
    const entries = state.text
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (field.minItems !== undefined && entries.length < field.minItems) {
      return {
        path,
        message: `${field.label} needs at least ${field.minItems} ${
          field.minItems === 1 ? "entry" : "entries"
        }.`,
      };
    }
    if (field.maxItems !== undefined && entries.length > field.maxItems) {
      return { path, message: `${field.label} allows at most ${field.maxItems} entries.` };
    }
    if (field.itemPattern) {
      const bad = entries.find((entry) => !field.itemPattern!.test(entry));
      if (bad !== undefined) {
        return {
          path,
          message: `${JSON.stringify(bad)} is not valid. ${field.itemPatternHint ?? ""}`.trim(),
        };
      }
    }
    return null;
  }

  if (text === "null") return null;

  // A stored secret is read as present-but-blank so it is never displayed,
  // and `writeGuidedConfig` keeps the stored value when it stays blank. That
  // is not an empty value, and must not block the save.
  if (field.secret && text.length === 0 && seeded?.present) return null;

  if (text.length === 0) {
    return {
      path,
      message: `${field.label} is set but empty. Clear the field to omit it instead.`,
    };
  }

  if (field.kind === "integer") {
    if (!/^-?\d+$/.test(text)) {
      return { path, message: `${field.label} must be a whole number.` };
    }
    const parsed = Number(text);
    if (field.minimum !== undefined && parsed < field.minimum) {
      return { path, message: `${field.label} must be at least ${field.minimum}.` };
    }
    if (field.maximum !== undefined && parsed > field.maximum) {
      return { path, message: `${field.label} must be at most ${field.maximum}.` };
    }
    return null;
  }

  if (field.kind === "enum") {
    const allowed = (field.enumValues ?? []).map((option) => option.value);
    if (!allowed.includes(text)) {
      return { path, message: `${field.label} must be one of ${allowed.join(", ")}.` };
    }
    return null;
  }

  if (field.pattern && !field.pattern.test(state.text)) {
    return {
      path,
      message: `${field.label} is not in the expected form. ${field.patternHint ?? ""}`.trim(),
    };
  }

  return null;
}

/**
 * Validate what the schema states. This is assistance before submission, not
 * a substitute for gateway admission: a configuration that passes here can
 * still be refused for a reason only the gateway knows.
 */
export function validateGuidedConfig(
  schema: PluginGuidedSchema,
  values: GuidedValues,
  config: JsonObject,
  seeded: GuidedValues = {},
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const path = fieldPath(section, field);
      const state = values[path];
      if (!state) continue;
      const issue = validateField(field, state, path, seeded[path]);
      if (issue) issues.push(issue);
    }
  }
  issues.push(...(schema.crossFieldErrors?.(config) ?? []));
  return issues;
}

/**
 * An enum field whose stored value is a spelling the gateway accepts but the
 * guided control does not offer — `limit_by: "Consumer"`, the `spiffe` alias.
 * The schema parses these case-insensitively, so they are valid; the control
 * can only show canonical values, so it would display nothing and validation
 * would refuse a configuration the gateway admits. Such a configuration is
 * edited as JSON rather than canonicalised behind the operator's back.
 */
export function unmodelledEnumSpelling(
  schema: PluginGuidedSchema,
  config: JsonObject,
): string | null {
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.kind !== "enum") continue;
      const container = section.path
        ? resolveContainer(config, section.path)
        : config;
      const value = container?.[field.key];
      if (typeof value !== "string") continue;
      const allowed = (field.enumValues ?? []).map((option) => option.value);
      if (!allowed.includes(value)) {
        return (
          `\`${field.key}\` is ${JSON.stringify(value)}, a spelling the gateway ` +
          `accepts but this view does not offer (${allowed.join(", ")}).`
        );
      }
    }
  }
  return null;
}
