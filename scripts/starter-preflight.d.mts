// Types for the TypeScript importers of `starter-preflight.mjs` (the server
// tests, which `tsconfig.server.test.json` type-checks). Declare an export
// here before importing it from TypeScript.

export const PASS: "pass";
export const FAIL: "fail";
export const UNKNOWN: "unknown";

export type PreflightStatus = typeof PASS | typeof FAIL | typeof UNKNOWN;

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
  remedy?: string;
}

export interface PreflightFetchInit {
  signal?: AbortSignal;
  redirect?: RequestRedirect;
  headers?: Record<string, string>;
}

export function checkTrustBoundary(
  env: Record<string, string | undefined>,
  fetchImpl?: (input: URL, init?: PreflightFetchInit) => Promise<Response>,
): Promise<PreflightCheck[]>;
