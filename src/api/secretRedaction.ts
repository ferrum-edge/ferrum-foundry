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
import {
  extractApiErrorData,
  extractApiErrorDetail,
  getCommittedWrite,
  isUnobservedWrite,
  markCommittedWrite,
  markUnobservedWrite,
} from "./client";

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

/**
 * The secrets a structured write payload carries, found by position rather
 * than by type of write: every string under a credential-shaped field name,
 * at any depth, and the credential-bearing parts of any URL elsewhere. Fails
 * closed on a whole subtree — `credentials`, `headers`, a `*_secret` object —
 * rather than trying to recognise which of its leaves is sensitive.
 */
export function secretValues(data: unknown): string[] {
  if (typeof data === "string") return urlSecrets(data);
  if (Array.isArray(data)) return data.flatMap(secretValues);
  if (data && typeof data === "object") {
    return Object.entries(data).flatMap(([field, value]) =>
      isSecretField(field) ? submittedValues(value) : secretValues(value));
  }
  return [];
}

/**
 * A multi-line value's lines long enough to carry key material on their own:
 * a PEM body line is 64 characters, and a parser that rejects one quotes that
 * line rather than the document. Short lines are armor or JSON structure.
 */
const MIN_SECRET_LINE = 16;

function secretLines(value: string): string[] {
  if (!/[\r\n]/.test(value)) return [];
  return value.split(/\r?\n|\r/).filter((line) => line.trim().length >= MIN_SECRET_LINE);
}

/**
 * Every form in which a submitted value can be echoed: raw, JSON-escaped, and
 * both again with surrounding whitespace trimmed — for the whole value and for
 * each substantial line of a multi-line one. Longest first, so a form is never
 * left partially exposed by a shorter one replaced inside it.
 */
export function redactionForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    const lines = secretLines(value).flatMap((line) => [line, line.trim()]);
    for (const candidate of [value, value.trim(), ...lines]) {
      if (!candidate) continue;
      forms.add(candidate);
      forms.add(JSON.stringify(candidate).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** `text` with every form of every submitted value replaced by `[REDACTED]`. */
export function redactSubmitted(text: string, forms: readonly string[]): string {
  let redacted = text;
  for (const form of forms) redacted = redacted.split(form).join(REDACTION_MARKER);
  return redacted;
}

/** A parsed error body with every string in it — keys included — redacted. */
export function redactBody(value: unknown, forms: readonly string[]): unknown {
  if (typeof value === "string") return redactSubmitted(value, forms);
  if (Array.isArray(value)) return value.map((item) => redactBody(item, forms));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redactSubmitted(key, forms), redactBody(item, forms)]));
  }
  return value;
}

/**
 * The gateway's detail for a rejected write, redacted before it is extracted.
 * Extraction trims and truncates each field, which would leave a long or
 * whitespace-padded secret no longer matching its submitted value, so
 * redaction must see the body exactly as the gateway sent it (#466).
 */
export async function redactedErrorDetail(
  error: Error,
  forms: readonly string[],
): Promise<string> {
  if ("data" in error) {
    const detail = extractApiErrorData(redactBody((error as { data?: unknown }).data, forms));
    if (detail) return redactSubmitted(detail, forms);
  }
  const response = "response" in error ? (error as { response?: Response }).response : undefined;
  if (!response) return "";
  try {
    const body = redactSubmitted(await response.clone().text(), forms);
    return redactSubmitted(extractApiErrorDetail(body), forms);
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
  secrets: readonly string[],
): Promise<RedactedWriteError> {
  const forms = redactionForms(secrets);
  const source = error instanceof Error
    ? (error as Error & { data?: unknown; response?: unknown })
    : undefined;
  let data: unknown;
  if (source && source.data !== undefined) {
    data = redactBody(source.data, forms);
  } else if (source?.response instanceof Response) {
    // A body ky did not parse is still unread on the response.
    try {
      const text = await source.response.clone().text();
      if (text) data = redactSubmitted(text, forms);
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
 * `RedactedWriteError` that no longer holds `secrets` or the request. Pair it
 * with the `SILENT_ERRORS` opt-out on the request: the global error popup is
 * reported from ky's error before this runs and would show the raw body.
 */
export async function withRedactedFailure<T>(
  secrets: readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw await redactWriteFailure(error, secrets);
  }
}
