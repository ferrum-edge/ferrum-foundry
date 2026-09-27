/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – shared display formatting                         */
/*                                                                     */
/*  Presentation only: every function here turns a value that is       */
/*  already known into text for a human. None of them parse input or   */
/*  change what a value means, and a missing or unparseable value       */
/*  renders the caller's fallback instead of "Invalid Date".            */
/* ------------------------------------------------------------------ */

export type DateInput = string | number | Date | null | undefined;

/** The placeholder for a value that is absent or cannot be shown. */
export const EMPTY_VALUE = "—";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A calendar date and time of day, e.g. "Sep 25, 2026, 08:40 PM". */
export function formatDateTime(value: DateInput, fallback: string = EMPTY_VALUE): string {
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : fallback;
}

/**
 * A time of day with seconds, e.g. "06:03:40 AM", for recent observations
 * whose date is implied by context (a probe column, a "generated" stamp).
 */
export function formatTime(value: DateInput, fallback: string = EMPTY_VALUE): string {
  const date = toDate(value);
  return date ? timeFormat.format(date) : fallback;
}

/** An ISO-8601 timestamp for `<time dateTime>`, or undefined when unknown. */
export function isoDateTime(value: DateInput): string | undefined {
  return toDate(value)?.toISOString();
}

/** Strings the gateway reports as timestamps, e.g. `2026-09-27T10:00:50.528Z`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && toDate(value) !== null;
}

/* ------------------------------------------------------------------ */
/*  Machine keys as labels                                             */
/* ------------------------------------------------------------------ */

/**
 * Words whose conventional spelling is not simple capitalisation. Keys are
 * the lower-case token as it appears in a snake_case field name.
 */
const ACRONYMS: Record<string, string> = {
  acl: "ACL",
  acme: "ACME",
  ai: "AI",
  api: "API",
  ca: "CA",
  cp: "CP",
  cpu: "CPU",
  crl: "CRL",
  crls: "CRLs",
  db: "DB",
  dns: "DNS",
  dp: "DP",
  dtls: "DTLS",
  fd: "FD",
  fds: "FDs",
  fips: "FIPS",
  grpc: "gRPC",
  hbone: "HBONE",
  hmac: "HMAC",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  ids: "IDs",
  ip: "IP",
  jwks: "JWKS",
  jwt: "JWT",
  ldap: "LDAP",
  lb: "LB",
  mtls: "mTLS",
  ocsp: "OCSP",
  oidc: "OIDC",
  quic: "QUIC",
  rps: "RPS",
  rss: "RSS",
  sni: "SNI",
  spiffe: "SPIFFE",
  sse: "SSE",
  sso: "SSO",
  svid: "SVID",
  tcp: "TCP",
  tls: "TLS",
  ttl: "TTL",
  udp: "UDP",
  uri: "URI",
  url: "URL",
  urls: "URLs",
  waf: "WAF",
  ws: "WS",
  xds: "xDS",
};

/**
 * A snake_case (or kebab-case) machine key as a sentence-case label:
 * `mtls_credentials` → "mTLS credentials", `config_generation` →
 * "Config generation", `cp_authority` → "CP authority".
 */
export function humanizeKey(key: string): string {
  const words = key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words
    .map((word, index) => {
      const acronym = ACRONYMS[word];
      if (acronym) return acronym;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
