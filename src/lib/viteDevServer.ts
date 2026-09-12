export const DEFAULT_DEV_PORT = 5173;
export const DEFAULT_BFF_PORT = 3001;

export interface ViteDevServerSettings {
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

function parsePort(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
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

/**
 * Resolve Vite's listen port and `/api` proxy target from an environment map.
 *
 * The caller passes `process.env`; this module lives under `src/` (browser
 * typings) so it must not touch Node globals itself.
 */
export function resolveViteDevServer(
  env: Record<string, string | undefined>,
): ViteDevServerSettings {
  return {
    port: parsePort(env, "VITE_DEV_PORT", DEFAULT_DEV_PORT),
    proxyTarget: parseBffUrl(env),
  };
}
