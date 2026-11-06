export const DEFAULT_DEV_PORT = 5173;
export const DEFAULT_BFF_PORT = 3001;
export const DEFAULT_DEV_HOST = "localhost";

export interface ViteDevServerSettings {
  host: string;
  port: number;
  proxyTarget: string;
}

function optionalEnv(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

const INTEGER_PATTERN = /^-?\d+$/;
const IPV4_OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/;
const NON_IPV6_CHARACTER_PATTERN = /[^0-9A-Fa-f:.]/;
const UNSAFE_HOST_CHARACTER_PATTERN = /[/\\?#@%\s]/;

function parsePort(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  if (!INTEGER_PATTERN.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseBffUrl(env: Record<string, string | undefined>): string {
  const raw = optionalEnv(env, "VITE_BFF_URL");
  if (raw === undefined) {
    const port = parsePort(env, "PORT", DEFAULT_BFF_PORT);
    return `http://localhost:${port}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("VITE_BFF_URL must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VITE_BFF_URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("VITE_BFF_URL must not contain credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "VITE_BFF_URL must be an origin without a path, query, or fragment",
    );
  }
  return parsed.origin;
}

function unwrapIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]") && value.length > 2) {
    return value.slice(1, -1);
  }
  return value;
}

function isIPv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!IPV4_OCTET_PATTERN.test(octet)) return false;
    return Number(octet) <= 255;
  });
}

function isIPv6(value: string): boolean {
  if (!value.includes(":") || NON_IPV6_CHARACTER_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(`http://[${value}]`);
    return !parsed.port && !parsed.username && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function parseDevHost(env: Record<string, string | undefined>): string {
  const raw = optionalEnv(env, "VITE_DEV_HOST");
  if (raw === undefined) return DEFAULT_DEV_HOST;

  const rejected =
    "VITE_DEV_HOST must be localhost, 127.0.0.1, ::1, or an explicit IP address";
  const lowered = raw.toLowerCase();
  // Vite treats boolean `true` as listen-on-all-interfaces. Reject the
  // string form so an env value cannot accidentally widen the bind.
  if (lowered === "true" || lowered === "false" || raw === "*") {
    throw new Error(rejected);
  }
  if (lowered === "localhost") return DEFAULT_DEV_HOST;
  if (UNSAFE_HOST_CHARACTER_PATTERN.test(raw)) throw new Error(rejected);

  const address = unwrapIpv6Brackets(raw);
  if (isIPv4(address) || isIPv6(address)) return address;
  throw new Error(rejected);
}

/**
 * Resolve Vite's listen address, listen port, and `/api` proxy target from
 * an environment map.
 *
 * The caller passes `process.env`; this module lives under `src/` (browser
 * typings) so it must not touch Node globals itself.
 */
export function resolveViteDevServer(
  env: Record<string, string | undefined>,
): ViteDevServerSettings {
  return {
    host: parseDevHost(env),
    port: parsePort(env, "VITE_DEV_PORT", DEFAULT_DEV_PORT),
    proxyTarget: parseBffUrl(env),
  };
}
