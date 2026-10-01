/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – masked secrets in role-projected reads           */
/*                                                                    */
/*  Non-admin reads of plugin configurations and upstreams put a      */
/*  redaction placeholder where a stored secret is withheld. Ferrum   */
/*  Edge v0.9.9 (ferrum-edge#5925) refuses with `400` a POST or PUT   */
/*  that writes one of those placeholders back at a site the caller's */
/*  own read masks, and names each site by JSON pointer. This module  */
/*  recognises the placeholders exactly as Edge does, so an editor    */
/*  seeded from a masked read can say which fields need a real value  */
/*  before anything is sent.                                          */
/*                                                                    */
/*  It imports nothing, so `scripts/gateway-contract-smoke.mjs` can   */
/*  load it directly.                                                 */
/* ------------------------------------------------------------------ */

/** Edge's `REDACTED_PLACEHOLDER`: a wholesale-withheld value. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";
/** Edge's `REDACTED_USERINFO_PLACEHOLDER`: `user:pass@` becomes `redacted@`. */
export const REDACTED_USERINFO_PLACEHOLDER = "redacted";
/** Edge's `REDACTED_PATH_PLACEHOLDER`, the whole path of a projected endpoint URL. */
export const REDACTED_PATH_PLACEHOLDER = "[REDACTED_PATH]";
/** Edge's `REDACTED_QUERY_PLACEHOLDER`, the whole query of a projected URL. */
export const REDACTED_QUERY_PLACEHOLDER = "[REDACTED_QUERY]";
/** Edge's `REDACTED_FRAGMENT_PLACEHOLDER`, the whole fragment of a projected URL. */
export const REDACTED_FRAGMENT_PLACEHOLDER = "[REDACTED_FRAGMENT]";

/** The only upstream site an `operator` read masks (`UPSTREAM_CONSUL_TOKEN_POINTER`). */
export const UPSTREAM_CONSUL_TOKEN_POINTER = "/service_discovery/consul/token";

/** Every plugin configuration site Edge's projection masks lies under `config`. */
export const PLUGIN_CONFIG_POINTER = "/config";

/** Shown beside every field that still holds a placeholder. */
export const MASKED_FIELD_NOTICE =
  "Hidden from your role: re-enter it, or clear it (clearing deletes the stored secret).";

/**
 * Whether `value` is a redaction placeholder: Edge's `is_redaction_placeholder`
 * (`src/admin/plugin_config_projection.rs` at v0.9.9), comparison for
 * comparison. Every check is exact against a placeholder constant, so a value
 * that merely resembles one is not matched:
 *
 * - the string is exactly `[REDACTED]`;
 * - or it parses as an absolute URL whose username is exactly `redacted` with
 *   no password, whose whole path is `/[REDACTED_PATH]`, whose whole query is
 *   `[REDACTED_QUERY]`, or whose whole fragment is `[REDACTED_FRAGMENT]`.
 *
 * Edge parses with the WHATWG-conformant `url` crate; `URL` here is the same
 * standard. An empty password is not serialized by either, so Edge's
 * `password().is_none()` is `password === ""`. Only strings qualify.
 */
export function isRedactionPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === REDACTED_PLACEHOLDER) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.username === REDACTED_USERINFO_PLACEHOLDER && parsed.password === "") ||
    parsed.pathname === `/${REDACTED_PATH_PLACEHOLDER}` ||
    parsed.search === `?${REDACTED_QUERY_PLACEHOLDER}` ||
    parsed.hash === `#${REDACTED_FRAGMENT_PLACEHOLDER}`
  );
}

/** One RFC 6901 reference token, escaped as Edge's `push_json_pointer_segment` does. */
export function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The JSON pointer of every value under `value` that is a placeholder, in
 * document order, each prefixed with `base`. Object keys are never values.
 */
export function placeholderPointers(value: unknown, base = ""): string[] {
  if (isRedactionPlaceholder(value)) return [base];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => placeholderPointers(item, `${base}/${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      placeholderPointers(item, `${base}/${pointerSegment(key)}`),
    );
  }
  return [];
}

/**
 * Placeholder sites in a plugin `config`, as pointers into the plugin body.
 *
 * Edge's projection only ever touches `config`. Which sites in it are masked
 * depends on the plugin's schema rules, a name floor, and a URL userinfo sweep;
 * this reports every placeholder in `config` rather than a second copy of that
 * classification. A value there that is exactly a placeholder constant came
 * from a masked read, or is one Edge treats as a placeholder anyway.
 */
export function pluginConfigPlaceholderPointers(config: unknown): string[] {
  return placeholderPointers(config, PLUGIN_CONFIG_POINTER);
}

interface MaybeConsulUpstream {
  service_discovery?: { consul?: { token?: unknown } | null } | null;
}

/**
 * Placeholder sites in an upstream. An `operator` read masks one field, the
 * Consul ACL token; Edge checks no other upstream site.
 */
export function upstreamPlaceholderPointers(upstream: MaybeConsulUpstream): string[] {
  return isRedactionPlaceholder(upstream.service_discovery?.consul?.token)
    ? [UPSTREAM_CONSUL_TOKEN_POINTER]
    : [];
}

/**
 * `value` with the member `pointer` names removed: a key is deleted, an array
 * element spliced out. Omitting a field is how a full-replacement `PUT` clears
 * it. Nothing is mutated; an unresolvable pointer returns `value` unchanged,
 * and the empty pointer (the whole document) returns `undefined`.
 */
export function removeAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return undefined;
  if (!pointer.startsWith("/")) return value;
  const segments = pointer.split("/").slice(1).map(unescapeSegment);

  const remove = (node: unknown, depth: number): unknown => {
    const segment = segments[depth];
    const last = depth === segments.length - 1;
    if (Array.isArray(node)) {
      const position = Number(segment);
      if (!/^(0|[1-9]\d*)$/.test(segment) || position >= node.length) return node;
      const copy = [...node];
      if (last) copy.splice(position, 1);
      else copy[position] = remove(copy[position], depth + 1);
      return copy;
    }
    if (node !== null && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) return node;
      const copy = { ...(node as Record<string, unknown>) };
      if (last) delete copy[segment];
      else copy[segment] = remove(copy[segment], depth + 1);
      return copy;
    }
    return node;
  };
  return remove(value, 0);
}

/**
 * A write Foundry refused before sending, because the body it would have to
 * send carries a placeholder Edge would refuse (or store in place of the
 * secret). `pointers` name the sites; no value is ever included.
 */
export class MaskedSecretWriteError extends Error {
  readonly pointers: readonly string[];

  constructor(message: string, pointers: readonly string[]) {
    super(message);
    this.name = "MaskedSecretWriteError";
    this.pointers = pointers;
  }
}

/** A masked-placeholder refusal, from Edge's `400` or from Foundry itself. */
export interface MaskedPlaceholderRefusal {
  /** The JSON pointers exactly as reported (Edge lists at most 16, then "…and N more"). */
  readonly pointers: readonly string[];
  /** The role Edge names, when the refusal came from Edge. */
  readonly role: string | null;
  /** True when Foundry refused before sending anything. */
  readonly local: boolean;
}

// Edge's `masked_placeholder_message`: "<Resource> field(s) <p1>, <p2> carry
// the redaction placeholder that '<role>' reads return in place of ...".
const EDGE_REFUSAL = /field\(s\) (.+?) carry the redaction placeholder that '([^']*)' reads return/s;

/**
 * Parse Edge's masked-placeholder `400` message, or `null` for any other text.
 *
 * Edge joins the pointers with `", "` and escapes only `~` and `/` in them
 * (RFC 6901), so a config key that itself contains `", "` is split into two
 * entries here. The message carries no other delimiter to recover it by; the
 * pieces are still shown verbatim and together still name the field.
 */
export function parseMaskedPlaceholderMessage(message: string): MaskedPlaceholderRefusal | null {
  const match = EDGE_REFUSAL.exec(message);
  if (!match) return null;
  return { pointers: match[1].split(", "), role: match[2], local: false };
}

function errorText(data: unknown): string {
  if (typeof data === "string") {
    try {
      return errorText(JSON.parse(data) as unknown);
    } catch {
      return data;
    }
  }
  if (data !== null && typeof data === "object") {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "";
}

/**
 * The masked-placeholder refusal behind `error`, following `cause` (a
 * membership plan wraps the plugin write's failure), or `null`. Only a `400`
 * whose body is Edge's refusal qualifies; the pointers are reported as Edge
 * wrote them, and carry no value.
 */
export function maskedPlaceholderRefusal(error: unknown): MaskedPlaceholderRefusal | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof MaskedSecretWriteError) {
      return { pointers: current.pointers, role: null, local: true };
    }
    const status = (current as { response?: { status?: unknown } }).response?.status;
    if (status === 400) {
      const refusal = parseMaskedPlaceholderMessage(
        errorText((current as { data?: unknown }).data),
      );
      if (refusal) return refusal;
    }
    current = current.cause;
  }
  return null;
}
