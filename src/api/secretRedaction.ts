/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – submitted secrets in rejected writes              */
/*                                                                    */
/*  A write that carries a secret — a consumer's credentials, a plugin */
/*  configuration's keys, TLS private key material — can be refused   */
/*  with a body that repeats it. ky's error also holds the request's  */
/*  options, body included, for as long as anything references it.   */
/*  A failed secret-bearing write is therefore replaced by a          */
/*  `RedactedWriteError`: the gateway's status and body with every    */
/*  submitted secret removed, and nothing else from the request.      */
/* ------------------------------------------------------------------ */

import { isRedactedField } from "@/lib/resourceBaseline";
import type { ApiError } from "./types";
import {
  extractApiErrorData,
  extractApiErrorDetail,
  getCommittedWrite,
  isUnobservedWrite,
  markCommittedWrite,
  markUnobservedWrite,
  onApiError,
  takeHeldReport,
} from "./client";
import {
  KAFKA_SAFE_PRODUCER_PROPERTIES,
  PLUGIN_SENSITIVITY,
  type Sensitivity,
} from "./pluginSensitivity";

/** What a submitted secret is replaced with, the gateway's own read marker. */
export const REDACTION_MARKER = "[REDACTED]";

/** Every string a payload carries: the values a credential write must not echo. */
export function submittedValues(data: unknown): string[] {
  if (typeof data === "string") return data ? [data] : [];
  if (Array.isArray(data)) return data.flatMap(submittedValues);
  if (data && typeof data === "object") return Object.values(data).flatMap(submittedValues);
  return [];
}

/**
 * The submitted values a failed write must not echo, by how surely each one
 * is a secret.
 */
export interface Secrets {
  /** Redacted wherever they occur: in any string of the body, and in its keys. */
  readonly values: readonly string[];
  /**
   * Short values that are secret only because nothing classifies them (an
   * unknown plugin's config, a spec document Foundry cannot parse), redacted
   * only where they stand as a whole token (`MIN_UNCLASSIFIED_SUBSTRING`).
   */
  readonly tokens: readonly string[];
}

const NO_SECRETS: Secrets = { values: [], tokens: [] };

function classified(values: readonly string[]): Secrets {
  return { values, tokens: [] };
}

function mergeSecrets(sets: readonly Secrets[]): Secrets {
  return {
    values: sets.flatMap((set) => set.values),
    tokens: sets.flatMap((set) => set.tokens),
  };
}

/**
 * The shortest value Foundry cannot classify that is redacted wherever it
 * occurs. Such a value is redacted anyway, failing closed, but a short one —
 * `a`, `1`, `on`, `error` — also occurs inside ordinary words, in the keys of
 * the gateway's error body (`error`, `code`), and in the `[REDACTED]` marker
 * itself. Replacing every occurrence would destroy the detail that diagnoses
 * the failure. A shorter one is redacted only where it stands as a whole token
 * of a string value, and never in an object key.
 */
const MIN_UNCLASSIFIED_SUBSTRING = 8;

/** `values` that are secret only because nothing classifies them. */
export function unclassified(values: readonly string[]): Secrets {
  const long: string[] = [];
  const short: string[] = [];
  for (const value of values) {
    (value.trim().length < MIN_UNCLASSIFIED_SUBSTRING ? short : long).push(value);
  }
  return { values: long, tokens: short };
}

/**
 * Field names whose value is credential material beyond the conflict dialog's
 * list (`isRedactedField`): the ones Ferrum Edge's plugin projection also
 * treats as secret — authentication header maps, webhook targets, service
 * account documents, and camelCase `*Key` fields `_key$` does not match.
 */
const SECRET_FIELD_EXTRA =
  /(headers$|webhook|service[_-]?account|(access|function|integrity)[_-]?key)/i;

function isSecretField(field: string): boolean {
  return isRedactedField(field) || SECRET_FIELD_EXTRA.test(field);
}

// scheme://[userinfo@]host[:port][path][?query][#fragment]. Userinfo runs to
// the last `@` before the path, so a password containing `@` is taken whole.
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\/(?:([^/?#\s]*)@)?[^/?#\s@]*(\S*)$/i;

/**
 * The parts of a URL that can carry a credential: userinfo, and a path, query
 * or fragment (collector vendors put tokens in the path and the query). A bare
 * `scheme://host[:port]` carries none and stays readable in the detail.
 */
function urlSecrets(value: string): string[] {
  const match = ABSOLUTE_URL.exec(value.trim());
  if (!match) return [];
  const userinfo = match[1] ?? "";
  const rest = match[2] === "/" ? "" : match[2];
  if (!userinfo && !rest) return [];
  return [value, userinfo, rest].filter(Boolean);
}

/* ---------- Plugin configurations: Ferrum Edge's projection ---------- */

/** Edge's `normalize_config_key`: case and `-`, `.`, `_` do not distinguish keys. */
function normalizeConfigKey(key: string): string {
  return key.replace(/[-._]/g, "").toLowerCase();
}

/** Edge's `DEFAULT_SENSITIVE_METADATA_KEYS`, matched as case-insensitive substrings. */
const SENSITIVE_METADATA_SUBSTRINGS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "cache_request_headers_snapshot",
  "grpc_web_shadowed_trailers",
  "claim_header.",
  "bearer",
  "password",
  "secret",
  "last_event_id",
  "last-event-id",
];

/** The substrings Edge's `is_sensitive_plugin_config_key` matches on a normalized key. */
const SENSITIVE_NORMALIZED_SUBSTRINGS = [
  "integritykey",
  "apikey",
  "accesskey",
  "functionkey",
  "clientsecret",
  "credential",
  "privatekey",
  "serviceaccountjson",
  "webhook",
];

/** A key's words, split at delimiters and case changes (`APIKey` → `API`, `Key`). */
function keySegments(key: string): string[] {
  return key.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z0-9]+/g) ?? [];
}

/**
 * Edge's name floor for a plugin `config` key (`is_sensitive_plugin_config_key`
 * over `is_sensitive_metadata_key`), without the operator's
 * `FERRUM_LOG_REDACT_METADATA_KEYS` extras, which Foundry cannot see.
 */
function isEdgeSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  const segments = keySegments(key).map((segment) => segment.toLowerCase());
  const normalized = normalizeConfigKey(key);
  return (
    // Internal-only metadata keys, which Edge also treats as sensitive.
    lower.startsWith("mesh.metrics.") ||
    lower === "grpc_web.request_trailers" ||
    (key.startsWith("_") && segments[0] === "dedup") ||
    SENSITIVE_METADATA_SUBSTRINGS.some((needle) => lower.includes(needle)) ||
    segments.includes("token") ||
    segments.includes("apikey") ||
    (segments.includes("api") && segments.includes("key")) ||
    normalized === "key" ||
    SENSITIVE_NORMALIZED_SUBSTRINGS.some((needle) => normalized.includes(needle))
  );
}

/** A value Edge projects as `sensitivity`, as the submitted strings it must not echo. */
function projectedSecrets(value: unknown, sensitivity: Sensitivity): string[] {
  if (value === null || value === undefined) return [];
  if (sensitivity === "endpoint" || sensitivity === "redis") {
    // Edge fails closed on a value it cannot decompose as a URL.
    return typeof value === "string" && ABSOLUTE_URL.test(value.trim())
      ? urlSecrets(value)
      : submittedValues(value);
  }
  if (sensitivity === "kafka" && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([property, setting]) =>
      KAFKA_SAFE_PRODUCER_PROPERTIES.has(property.trim().toLowerCase())
        ? []
        : submittedValues(setting));
  }
  return submittedValues(value);
}

/**
 * Edge's `apply_rule`: `*` names each entry of an object or array, a named
 * segment matches normalized keys and passes through arrays, and a scalar
 * where the rule expects a container is secret.
 */
function ruleSecrets(value: unknown, path: readonly string[], sensitivity: Sensitivity): string[] {
  if (path.length === 0) return projectedSecrets(value, sensitivity);
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.flatMap((item) => head === "*"
      ? ruleSecrets(item, rest, sensitivity)
      : ruleSecrets(item, path, sensitivity));
  }
  if (value && typeof value === "object") {
    const wanted = normalizeConfigKey(head);
    return Object.entries(value).flatMap(([key, child]) =>
      head === "*" || normalizeConfigKey(key) === wanted
        ? ruleSecrets(child, rest, sensitivity)
        : []);
  }
  return projectedSecrets(value, "secret");
}

/**
 * Edge's floor beneath the schema (`redact_sensitive_plugin_config_fields`
 * and the URL sweep), widened by Foundry's own field-name heuristic.
 */
function configFloorSecrets(data: unknown): string[] {
  if (typeof data === "string") return urlSecrets(data);
  if (Array.isArray(data)) return data.flatMap(configFloorSecrets);
  if (data && typeof data === "object") {
    return Object.entries(data).flatMap(([field, value]) => {
      if (isSecretField(field) || isEdgeSensitiveConfigKey(field)) return submittedValues(value);
      if (normalizeConfigKey(field) === "redisurl") return projectedSecrets(value, "redis");
      return configFloorSecrets(value);
    });
  }
  return [];
}

/**
 * The secrets a plugin `config` carries, as Ferrum Edge's projection decides
 * them for a non-admin read (`project_plugin_config`): the plugin's schema
 * rules, then the name floor and URL sweep. A config of a known plugin that is
 * not an object is secret throughout, as Edge replaces it wholesale. A plugin
 * with no known schema has only the name floor and URL sweep to classify it
 * by, so every other string it carries is secret too, unclassified.
 */
export function pluginConfigSecrets(pluginName: string, config: unknown): Secrets {
  if (config === null || config === undefined) return NO_SECRETS;
  const rules = PLUGIN_SENSITIVITY.get(pluginName);
  if (!rules) {
    return mergeSecrets([
      classified(configFloorSecrets(config)),
      unclassified(submittedValues(config)),
    ]);
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return classified(submittedValues(config));
  }
  return classified([...new Set([
    ...rules.flatMap((rule) => ruleSecrets(config, rule.path, rule.sensitivity)),
    ...configFloorSecrets(config),
  ])]);
}

/**
 * The secrets a structured write payload carries, found by position rather
 * than by type of write: every string under a credential-shaped field name,
 * at any depth, and the credential-bearing parts of any URL elsewhere. Fails
 * closed on a whole subtree — `credentials`, `headers`, a `*_secret` object —
 * rather than trying to recognise which of its leaves is sensitive. A plugin
 * configuration (`plugin_name` beside `config`) at any depth — a plugin write,
 * or one entry of a batch — has its `config` classified by
 * `pluginConfigSecrets`.
 */
export function secretValues(data: unknown): Secrets {
  if (typeof data === "string") return classified(urlSecrets(data));
  if (Array.isArray(data)) return mergeSecrets(data.map(secretValues));
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const pluginName = record.plugin_name;
    if (typeof pluginName === "string" && "config" in record) {
      const { config, ...rest } = record;
      return mergeSecrets([pluginConfigSecrets(pluginName, config), secretValues(rest)]);
    }
    return mergeSecrets(Object.entries(record).map(([field, value]) =>
      isSecretField(field) ? classified(submittedValues(value)) : secretValues(value)));
  }
  return NO_SECRETS;
}

/* ---------- Restore and API spec documents ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The secrets a backup carries into a restore: what `secretValues` finds in
 * its resources — consumer credentials, plugin configurations, upstream
 * discovery tokens — and every API spec document in it. A document travels
 * gzip-compressed and base64-encoded (`spec_content_base64`, and its
 * external-`$ref` snapshot), which no position inside it can be read from, so
 * each is taken whole.
 */
export function restoreSecrets(backup: unknown): Secrets {
  const section = isRecord(backup) ? backup.api_specs : undefined;
  const items = isRecord(section) && Array.isArray(section.items) ? section.items : [];
  const documents = items.flatMap((item) => isRecord(item)
    ? [item.spec_content_base64, item.external_ref_snapshot_base64]
      .filter((value): value is string => typeof value === "string" && value !== "")
    : []);
  return mergeSecrets([secretValues(backup), classified(documents)]);
}

/**
 * The secrets an API spec document carries into an import or replacement.
 * Its secrets live in the `x-ferrum-*` extensions — above all plugin
 * configurations in `x-ferrum-plugins` — but anything in the document can be
 * quoted back by a parse or validation error.
 *
 * A JSON document is classified by position like any other write: each
 * `x-ferrum-plugins` entry by its plugin's projection, credential-named fields
 * and URL credentials wherever they are. An entry that is not a plugin
 * configuration is unclassified throughout. A document Foundry cannot parse —
 * YAML, for which it has no parser, or malformed JSON — cannot be classified,
 * so every scalar it could hold is unclassified (`yamlScalars`).
 */
export function specDocumentSecrets(document: string): Secrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return unclassified(yamlScalars(document));
  }
  if (!isRecord(parsed)) return unclassified(yamlScalars(document));
  const { "x-ferrum-plugins": plugins, ...rest } = parsed;
  const entries: unknown[] = Array.isArray(plugins) ? plugins : plugins === undefined ? [] : [plugins];
  return mergeSecrets([
    secretValues(rest),
    ...entries.map((entry) => isRecord(entry) && typeof entry.plugin_name === "string"
      ? secretValues(entry)
      : unclassified(submittedValues(entry))),
  ]);
}

/** YAML's double-quoted escapes (YAML 1.2 §5.7), other than the numeric ones. */
const YAML_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

function unescapeDoubleQuoted(text: string): string {
  return text.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,
    (escape, code: string) => {
      if (code.length > 1) {
        try {
          return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
        } catch {
          return escape;
        }
      }
      return YAML_ESCAPES[code] ?? escape;
    },
  );
}

/** The index just past the quoted scalar `text` opens with, or -1 if it does not close. */
function quotedEnd(text: string): number {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") {
      index += 1;
    } else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1;
      } else {
        return index + 1;
      }
    }
  }
  return -1;
}

/** The elements of a flow collection, split at `,`, `[`, `]`, `{` and `}` outside quotes. */
function flowPieces(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    current += character;
    if (quote) {
      if (quote === '"' && character === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          quote = null;
        }
      }
    } else if (character === '"' || character === "'") {
      // A quote opens a scalar only where one can start, not inside a word.
      if (/^\s*$|:\s*$/.test(current.slice(0, -1))) quote = character;
    } else if (",[]{}".includes(character)) {
      pieces.push(current.slice(0, -1));
      current = "";
    }
  }
  pieces.push(current);
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/** The value of a `key: value` pair, the key plain or quoted, or null if `text` is not one. */
function mappingValue(text: string): string | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text);
    if (end === -1) return null;
    const separator = /^\s*:(?:\s|$)/.exec(text.slice(end));
    return separator ? text.slice(end + separator[0].length).trim() : null;
  }
  if (text.startsWith("{") || text.startsWith("[")) return null;
  const separator = /:(?:\s|$)/.exec(text);
  return separator ? text.slice(separator.index + separator[0].length).trim() : null;
}

function addScalar(raw: string, found: Set<string>): void {
  const text = raw.trim();
  // A block scalar's indicator; its content is on the lines that follow.
  if (!text || /^[|>][-+0-9]*(?:\s+#.*)?$/.test(text)) return;
  found.add(text);
  const bare = text.replace(/^(?:[&!]\S*\s+)+/, "");
  if (bare !== text) {
    addScalar(bare, found);
    return;
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text);
    const inner = end === -1 ? text.slice(1) : text.slice(1, end - 1);
    if (!inner.trim()) return;
    found.add(inner);
    found.add(text.startsWith('"') ? unescapeDoubleQuoted(inner) : inner.replaceAll("''", "'"));
    return;
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    for (const piece of flowPieces(text)) {
      addScalar(piece, found);
      const value = mappingValue(piece);
      if (value !== null) addScalar(value, found);
    }
    return;
  }
  // A plain scalar, or a line of a multi-line one: without a trailing comment
  // or a stray quote from the line that closes a quoted scalar, and unescaped
  // in case it continues a double-quoted one.
  for (const variant of [
    text.replace(/\s+#.*$/, ""),
    text.replace(/^["']|["']$/g, ""),
    unescapeDoubleQuoted(text),
  ]) {
    if (variant.trim()) found.add(variant.trim());
  }
}

/**
 * Every scalar a YAML document could hold, found without parsing it. Over-
 * inclusive by design: each line after any sequence or mapping indicator,
 * whole; the value of each `key: value` pair; each element of a flow
 * collection; and each quoted scalar unquoted and unescaped. A block or
 * multi-line scalar is covered line by line, so a value the gateway echoes
 * folded or joined is redacted piece by piece. A line that is only a key
 * (`x-ferrum-plugins:`) holds no scalar: taken whole, it would redact the
 * gateway's own reference to that key.
 */
export function yamlScalars(document: string): string[] {
  const found = new Set<string>();
  for (const line of document.split(/\r\n|\r|\n/)) {
    const rest = line.trim().replace(/^(?:[-?:](?:\s+|$))+/, "");
    const value = mappingValue(rest);
    if (value === "") continue;
    addScalar(rest, found);
    if (value !== null) addScalar(value, found);
  }
  return [...found];
}

/**
 * A multi-line value's lines long enough to carry key material on their own:
 * a PEM body line is 64 characters, and a parser that rejects one quotes that
 * line rather than the document. A shorter line — the tail of a PEM body,
 * JSON punctuation — is too short to be distinctive and is covered where the
 * whole value is echoed.
 */
const MIN_SECRET_LINE = 16;

/**
 * A PEM armor line (`-----BEGIN CERTIFICATE-----`). It is the same fixed text
 * in every document of its type and carries no key material, and a parser's
 * error names it ("expected -----BEGIN PRIVATE KEY-----"), so it stays
 * readable; only the base64 body between the armor lines is redacted.
 */
const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

function secretLines(value: string): string[] {
  if (!/[\r\n]/.test(value)) return [];
  return value.split(/\r?\n|\r/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length >= MIN_SECRET_LINE && !PEM_ARMOR_LINE.test(trimmed);
  });
}

/** Every form of every submitted secret, as matched in a failure's body. */
export interface RedactionForms {
  /** Matched wherever they occur, in a string or an object key. Longest first. */
  readonly substrings: readonly string[];
  /** Matched only as a whole token of a string (`MIN_UNCLASSIFIED_SUBSTRING`). */
  readonly tokens: readonly string[];
}

/**
 * Every form in which a submitted value can be echoed: raw, JSON-escaped, and
 * both again with surrounding whitespace trimmed — for the whole value and for
 * each substantial line of a multi-line one.
 */
function addForms(value: string, forms: Set<string>): void {
  const lines = secretLines(value).flatMap((line) => [line, line.trim()]);
  for (const candidate of [value, value.trim(), ...lines]) {
    if (!candidate) continue;
    forms.add(candidate);
    forms.add(JSON.stringify(candidate).slice(1, -1));
  }
}

/**
 * The forms of `secrets` to redact. A plain list is classified throughout. A
 * short unclassified value that is also classified is matched wherever it
 * occurs, as the classified one must be.
 */
export function redactionForms(secrets: Secrets | readonly string[]): RedactionForms {
  const { values, tokens } = "tokens" in secrets ? secrets : classified(secrets);
  const substrings = new Set<string>();
  for (const value of values) addForms(value, substrings);
  const whole = new Set<string>();
  for (const value of tokens) addForms(value, whole);
  const longestFirst = (a: string, b: string) => b.length - a.length;
  return {
    substrings: [...substrings].sort(longestFirst),
    tokens: [...whole].filter((form) => form.trim() && !substrings.has(form)).sort(longestFirst),
  };
}

function isTokenCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/** Where each of `forms` occurs in `text`, as `[start, end)` spans. */
function occurrences(
  text: string,
  forms: readonly string[],
  wholeToken: boolean,
): [number, number][] {
  const spans: [number, number][] = [];
  for (const form of forms) {
    if (!form) continue;
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      const end = at + form.length;
      if (!wholeToken || (!isTokenCharacter(text[at - 1]) && !isTokenCharacter(text[end]))) {
        spans.push([at, end]);
      }
    }
  }
  return spans;
}

/**
 * `text` with each span replaced by `[REDACTED]`, overlapping spans as one.
 * Every span is found in the original text and replaced in one pass, so every
 * occurrence of every form is covered whatever their lengths and overlaps, and
 * a marker already written is never matched and split by a later form.
 */
function replaceSpans(text: string, spans: [number, number][]): string {
  if (spans.length === 0) return text;
  spans.sort(([a], [b]) => a - b);
  let redacted = "";
  let cursor = 0;
  let [start, end] = spans[0];
  for (const [nextStart, nextEnd] of spans.slice(1)) {
    if (nextStart < end) {
      end = Math.max(end, nextEnd);
      continue;
    }
    redacted += text.slice(cursor, start) + REDACTION_MARKER;
    cursor = end;
    [start, end] = [nextStart, nextEnd];
  }
  return redacted + text.slice(cursor, start) + REDACTION_MARKER + text.slice(end);
}

/** `text` with every form of every submitted value replaced by `[REDACTED]`. */
export function redactSubmitted(text: string, forms: RedactionForms): string {
  return replaceSpans(text, [
    ...occurrences(text, forms.substrings, false),
    ...occurrences(text, forms.tokens, true),
  ]);
}

/**
 * `text` with only the substring forms replaced: an object key, or text built
 * from a body whose strings were each redacted already. A whole-token form
 * matched there would find the body's structure — its keys, serialized — not
 * anything submitted.
 */
function redactStructure(text: string, forms: RedactionForms): string {
  return replaceSpans(text, occurrences(text, forms.substrings, false));
}

/**
 * A parsed error body with every string in it redacted, and every key too,
 * except against a short unclassified value (`MIN_UNCLASSIFIED_SUBSTRING`).
 */
export function redactBody(value: unknown, forms: RedactionForms): unknown {
  if (typeof value === "string") return redactSubmitted(value, forms);
  if (Array.isArray(value)) return value.map((item) => redactBody(item, forms));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redactStructure(key, forms), redactBody(item, forms)]));
  }
  return value;
}

/**
 * An error body the client did not parse, redacted. JSON text is redacted
 * value by value, as a parsed body is, so its keys keep the same protection;
 * anything else as text.
 */
function redactBodyText(text: string, forms: RedactionForms): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactSubmitted(text, forms);
  }
  if (!parsed || typeof parsed !== "object") return redactSubmitted(text, forms);
  return redactStructure(JSON.stringify(redactBody(parsed, forms)), forms);
}

function redactData(data: unknown, forms: RedactionForms): unknown {
  return typeof data === "string" ? redactBodyText(data, forms) : redactBody(data, forms);
}

/**
 * The gateway's detail for a rejected write, redacted before it is extracted.
 * Extraction trims and truncates each field, which would leave a long or
 * whitespace-padded secret no longer matching its submitted value, so
 * redaction must see the body exactly as the gateway sent it (#466).
 */
export async function redactedErrorDetail(
  error: Error,
  forms: RedactionForms,
): Promise<string> {
  if ("data" in error) {
    const detail = extractApiErrorData(redactData((error as { data?: unknown }).data, forms));
    if (detail) return redactStructure(detail, forms);
  }
  const response = "response" in error ? (error as { response?: Response }).response : undefined;
  if (!response) return "";
  try {
    const body = redactBodyText(await response.clone().text(), forms);
    return redactStructure(extractApiErrorDetail(body), forms);
  } catch {
    return "";
  }
}

/**
 * A secret-bearing write the gateway refused, or whose answer never arrived.
 *
 * It keeps what callers decide on — the HTTP status and headers (`response`,
 * bodiless) and the parsed body (`data`) with every submitted secret replaced
 * by `[REDACTED]` — so `getApiErrorDetail`, `isPreconditionFailed` and the
 * outcome classifiers read it exactly as they read a ky `HTTPError`. It keeps
 * no `request`, no `options` and no `cause`: those hold the request body.
 * The committed-write and unobserved-write markers are carried over.
 */
export class RedactedWriteError extends Error {
  // Declared, not initialized: an absent status or body must not be an own
  // `undefined` property, which `"response" in error` checks would accept.
  declare readonly response?: Response;
  declare readonly data?: unknown;

  constructor(message: string, response: Response | undefined, data: unknown) {
    super(message);
    this.name = "RedactedWriteError";
    if (response) Object.defineProperty(this, "response", { value: response, enumerable: true });
    if (data !== undefined) Object.defineProperty(this, "data", { value: data, enumerable: true });
  }
}

function bodilessResponse(response: unknown): Response | undefined {
  if (!(response instanceof Response)) return undefined;
  try {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // A status `Response` cannot be constructed with carries no decision.
    return undefined;
  }
}

/**
 * `error` with every form of every value in `secrets` removed from its message
 * and body, as a `RedactedWriteError`. The body is redacted while it is still
 * whole — before any extraction trims or truncates it.
 */
export async function redactWriteFailure(
  error: unknown,
  secrets: Secrets | readonly string[],
): Promise<RedactedWriteError> {
  const forms = redactionForms(secrets);
  const source = error instanceof Error
    ? (error as Error & { data?: unknown; response?: unknown })
    : undefined;
  let data: unknown;
  if (source && source.data !== undefined) {
    data = redactData(source.data, forms);
  } else if (source?.response instanceof Response) {
    // A body ky did not parse is still unread on the response.
    try {
      const text = await source.response.clone().text();
      if (text) data = redactBodyText(text, forms);
    } catch {
      // Already consumed — nothing further to recover.
    }
  }
  const redacted = new RedactedWriteError(
    source ? redactSubmitted(source.message, forms) : "Request failed",
    bodilessResponse(source?.response),
    data,
  );
  const committed = getCommittedWrite(error);
  if (committed) markCommittedWrite(redacted, committed);
  if (isUnobservedWrite(error)) markUnobservedWrite(redacted);
  return redacted;
}

/**
 * Run a secret-bearing write, replacing any failure with a
 * `RedactedWriteError` that no longer holds `secrets` or the request.
 *
 * Its request must carry `REDACT_ERRORS` (or `SILENT_ERRORS`, when the caller
 * reports every failure itself): the global error popup is raised from ky's
 * error, before this runs, and would show the raw body. `REDACT_ERRORS` holds
 * that report instead, and it is raised here with the submitted secrets
 * removed from its body — the same status, URL and unobserved outcome, so a
 * write whose answer was lost still opens the "Outcome unknown" dialog. A
 * failure the popup never reports (a committed write, a handled status) is
 * not held, so nothing is raised for it here either.
 */
export async function withRedactedFailure<T>(
  secrets: Secrets | readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const held = takeHeldReport(error);
    const redacted = await redactWriteFailure(error, secrets);
    if (held) onApiError(redactReport(held, redacted, redactionForms(secrets)));
    throw redacted;
  }
}

/**
 * A held popup report with every submitted secret removed. The body is
 * rebuilt the way the client builds it (`beforeError` in `client.ts`) but
 * from the redacted error, whose body was redacted string by string: the
 * serialized raw body can hold an echo JSON-escaped twice (a field that is
 * itself JSON), which no redaction form matches. The unobserved outcome's
 * detail repeats the gateway's `error` string, so it is redacted too.
 */
function redactReport(
  report: ApiError,
  redacted: RedactedWriteError,
  forms: RedactionForms,
): ApiError {
  const { outcome } = report;
  const data = report.statusCode === 0 ? redacted.message : redacted.data;
  const body = typeof data === "string" ? data : data === undefined ? "" : JSON.stringify(data);
  return {
    ...report,
    body: redactStructure(body, forms),
    ...(outcome && {
      outcome: {
        ...outcome,
        detail: outcome.detail === null ? null : redactSubmitted(outcome.detail, forms),
      },
    }),
  };
}
