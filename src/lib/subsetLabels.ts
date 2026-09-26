/* ------------------------------------------------------------------ */
/*  Subset label selectors as lossless key/value drafts                */
/* ------------------------------------------------------------------ */

/**
 * Edge compares a subset label to a target tag by exact key and value, and
 * restricts neither delimiter characters nor surrounding whitespace. A
 * selector is therefore edited as separate key and value fields — never as a
 * `key=value, …` string, which cannot represent a `,` in a value or a `=` in a
 * key (#479) — and a selector the operator has not touched is written back as
 * the exact map that was read.
 */

export interface SubsetLabelRow {
  id: number;
  key: string;
  value: string;
}

export interface SubsetLabelsDraft {
  rows: SubsetLabelRow[];
  /** The selector as read, or `null` for a subset this form created. */
  original: Record<string, string> | null;
  /** Set by any row edit, addition, or removal. */
  edited: boolean;
}

export function subsetLabelsDraft(
  labels: Record<string, string> | null,
  nextId: () => number,
): SubsetLabelsDraft {
  return {
    rows: Object.entries(labels ?? {}).map(([key, value]) => ({ id: nextId(), key, value })),
    original: labels,
    edited: false,
  };
}

/**
 * Per-row and whole-selector errors for a draft. An untouched selector is
 * never judged here: it is written back exactly as read.
 */
export interface SubsetLabelErrors {
  rows: Record<number, string>;
  selector?: string;
}

export function validateSubsetLabels(draft: SubsetLabelsDraft): SubsetLabelErrors | null {
  if (!draft.edited && draft.original !== null) return null;
  const rows: Record<number, string> = {};
  const seen = new Set<string>();
  for (const row of draft.rows) {
    if (row.key === "") {
      rows[row.id] = row.value === "" ? "Enter a label or remove this row" : "Label key is required";
    } else if (seen.has(row.key)) {
      rows[row.id] = `Duplicate label key "${row.key}"`;
    }
    seen.add(row.key);
  }
  const selector = draft.rows.length === 0
    ? "A subset must select at least one label"
    : undefined;
  if (Object.keys(rows).length === 0 && !selector) return null;
  return { rows, ...(selector && { selector }) };
}

/**
 * The selector a save writes. Only called for a draft `validateSubsetLabels`
 * accepted; keys and values are sent exactly as entered.
 */
export function subsetLabelsForSubmit(draft: SubsetLabelsDraft): Record<string, string> {
  if (!draft.edited && draft.original !== null) return draft.original;
  return Object.fromEntries(draft.rows.map((row) => [row.key, row.value]));
}
