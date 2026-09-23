/* ------------------------------------------------------------------ */
/*  Editing drafts for numeric and comma-separated form fields         */
/* ------------------------------------------------------------------ */

// A controlled input must render what the operator typed, not a value
// re-derived from parsed state on every keystroke: `Number("")` is `0`, so a
// cleared numeric field snaps to `0`, and re-joining a parsed list drops the
// comma the operator just typed. Numeric fields therefore hold `""` while
// empty, and list fields keep their raw text; both are parsed and validated
// on blur or submit, never per keystroke.

/** A numeric field's editing value: the entered number, or `""` while empty. */
export type NumberDraft = number | "";

/**
 * `T` with the numeric fields `K` widened to accept an empty draft. Optional
 * fields stay optional, so an absent value is still omitted on submit.
 */
export type WithNumberDrafts<T, K extends keyof T> = Omit<T, K> & {
  [P in keyof Pick<T, K>]: Pick<T, K>[P] | "";
};

/** Render a numeric draft into an input's `value`. */
export function numberDraftText(value: NumberDraft | null | undefined): string {
  return value === "" || value == null ? "" : String(value);
}

/**
 * Read a numeric draft from an `<input type="number">`. The browser reports
 * `""` for an empty or unfinished entry, which stays empty instead of
 * becoming `0`.
 */
export function numberDraftFromInput(raw: string): NumberDraft {
  return raw === "" ? "" : Number(raw);
}

/** The error for a required numeric field left empty, if it is. */
export function missingNumberError(value: NumberDraft | undefined, label: string): string | undefined {
  return value === "" ? `${label} is required` : undefined;
}

/** `D` with the empty-draft case removed from the fields `K`. */
export type ResolvedNumberDrafts<D, K extends keyof D> = {
  [P in keyof D]: P extends K ? Exclude<D[P], ""> : D[P];
};

/**
 * Narrow a draft for submit once validation has rejected every empty field in
 * `keys`. Reaching an empty field here is a validation bug, so it throws
 * rather than sending a blank value.
 */
export function resolveNumberDrafts<D extends object, K extends keyof D>(
  draft: D,
  keys: readonly K[],
): ResolvedNumberDrafts<D, K> {
  for (const key of keys) {
    if ((draft[key] as unknown) === "") {
      throw new Error(`Numeric field ${String(key)} is empty after validation`);
    }
  }
  return draft as unknown as ResolvedNumberDrafts<D, K>;
}

/** Render a list into its comma-separated editing text. */
export function formatCommaList(values: readonly (string | number)[] | null | undefined): string {
  return (values ?? []).join(", ");
}

/** Split comma-separated text into trimmed entries, ignoring empty segments. */
export function parseCommaList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** HTTP status codes the gateway accepts in health-check code lists. */
export const HTTP_STATUS_MIN = 100;
export const HTTP_STATUS_MAX = 599;

export type StatusCodeListResult =
  | { ok: true; codes: number[] }
  | { ok: false; error: string };

/**
 * Parse comma-separated HTTP status codes. Every entry must be a complete
 * integer in the gateway's accepted range; a partial token such as `200x` is
 * rejected rather than truncated to `200`.
 */
export function parseStatusCodeList(text: string): StatusCodeListResult {
  const codes: number[] = [];
  for (const entry of parseCommaList(text)) {
    const code = /^\d+$/.test(entry) ? Number(entry) : NaN;
    if (!Number.isInteger(code) || code < HTTP_STATUS_MIN || code > HTTP_STATUS_MAX) {
      return {
        ok: false,
        error: `"${entry}" is not an HTTP status code (${HTTP_STATUS_MIN}-${HTTP_STATUS_MAX})`,
      };
    }
    codes.push(code);
  }
  return { ok: true, codes };
}

/** Editing state for a comma-separated status-code field. */
export interface StatusCodeListDraft {
  /** The text the field was seeded with. */
  seedText: string;
  /** The list the field was seeded from; `undefined` when absent. */
  seedCodes: number[] | undefined;
  /** What the operator has typed. */
  text: string;
}

export function statusCodeListDraft(codes: number[] | undefined): StatusCodeListDraft {
  const seedText = formatCommaList(codes);
  return { seedText, seedCodes: codes, text: seedText };
}

/**
 * Resolve a status-code draft on submit. Text the operator never changed
 * returns the seeded list untouched, so an absent list stays absent instead of
 * being rewritten as `[]`.
 */
export function resolveStatusCodeListDraft(
  draft: StatusCodeListDraft,
): { ok: true; codes: number[] | undefined } | { ok: false; error: string } {
  if (draft.text === draft.seedText) return { ok: true, codes: draft.seedCodes };
  return parseStatusCodeList(draft.text);
}
