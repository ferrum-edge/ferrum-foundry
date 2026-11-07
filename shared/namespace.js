/**
 * Ferrum Edge's namespace identifier policy, shared by the BFF, the admin JWT
 * signer and the SPA. Pure: no Node or browser APIs, so Vite can bundle it.
 *
 * Only the rule lives here. Each caller keeps its own answer to a refusal
 * (throw, `null`, `400`, or a form message) and its own grant semantics
 * (wildcards, absent headers).
 */

/** Edge's name limit, in characters (the grammar is ASCII-only). */
export const NAMESPACE_NAME_MAX_LENGTH = 254;
const NAMESPACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;

/**
 * Whether `value` is a namespace name Edge accepts:
 * `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, 1-254 characters. Without the `m` flag, `$`
 * matches only at the very end, so a trailing newline is refused.
 */
export function isNamespaceName(value) {
  return typeof value === 'string' && NAMESPACE_NAME_PATTERN.test(value);
}

/** Edge's description limit, in Unicode scalar values after trimming. */
export const NAMESPACE_DESCRIPTION_MAX_LENGTH = 1024;
const WHITE_SPACE_PATTERN = /^\p{White_Space}$/u;

/**
 * Trim a description as Edge's `str::trim` does: Unicode `White_Space`, which
 * includes NEXT LINE (U+0085) but, unlike JS `trim()`, not the BOM (U+FEFF).
 *
 * Scanned from both ends in linear time: a `\p{White_Space}+$` regex
 * backtracks quadratically over a long whitespace run inside the text. Every
 * `White_Space` character is in the BMP, so testing UTF-16 code units is exact.
 */
export function normalizeNamespaceDescription(description) {
  let start = 0;
  let end = description.length;
  while (start < end && WHITE_SPACE_PATTERN.test(description[start])) start += 1;
  while (end > start && WHITE_SPACE_PATTERN.test(description[end - 1])) end -= 1;
  return description.slice(start, end);
}

/**
 * Why Edge would refuse `description`, or `null` when it is acceptable:
 * `'invalid-unicode'` for a lone surrogate (not a Unicode scalar value), else
 * `'too-long'` past {@link NAMESPACE_DESCRIPTION_MAX_LENGTH} scalar values
 * after trimming.
 */
export function namespaceDescriptionProblem(description) {
  const characters = [...normalizeNamespaceDescription(description)];
  if (characters.some((character) => {
    const code = character.codePointAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  })) return 'invalid-unicode';
  if (characters.length > NAMESPACE_DESCRIPTION_MAX_LENGTH) return 'too-long';
  return null;
}
