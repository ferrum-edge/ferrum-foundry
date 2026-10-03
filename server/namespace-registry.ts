import { Response } from 'undici';
import type { AuthPrincipal } from './auth-types.js';

// Absolute end assertion: JS `$` alone also matches before a final newline.
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}(?![\s\S])/;
const PAGE_SIZE = 1000;
const PAGE_BYTES = 1024 * 1024;

export class RegistryRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isRegistryPath(path: string): boolean {
  return path === '/namespaces' || path.startsWith('/namespaces/');
}

export function registryNameAllowed(principal: AuthPrincipal, name: string): boolean {
  return principal.namespaces === undefined || principal.namespaces.includes(name);
}

// Use only the canonical pathname shared with forwarding. Unknown registry
// methods/subpaths need an explicit policy before they may reach the gateway.
export function authorizeRegistryPath(path: string, method: string, principal: AuthPrincipal): void {
  if (!isRegistryPath(path)) return;
  const collection = path === '/namespaces';
  const name = path.slice('/namespaces/'.length);
  if (!(collection ? ['GET', 'POST'] : ['GET', 'PUT', 'DELETE']).includes(method)
    || (!collection && !NAME_PATTERN.test(name))) {
    throw new RegistryRequestError(400, 'Unsupported namespace registry operation');
  }
  if (method !== 'GET' && principal.role !== 'admin') {
    throw new RegistryRequestError(403, 'Insufficient role');
  }
  if (!collection && !registryNameAllowed(principal, name)) {
    throw new RegistryRequestError(403, 'Namespace access denied');
  }
}

/** Require a literal namespace echo before a cascade request is signed or forwarded. */
export function authorizeRegistryDeleteConfirmation(
  path: string,
  method: string,
  rawUrl: string,
): void {
  if (method !== 'DELETE' || !path.startsWith('/namespaces/')) return;
  const targetName = path.slice('/namespaces/'.length);
  const query = rawUrl.split('?', 2)[1] ?? '';
  const confirmations: string[] = [];
  for (const parameter of query.split('&')) {
    const separator = parameter.indexOf('=');
    const rawKey = separator < 0 ? parameter : parameter.slice(0, separator);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replaceAll('+', ' '));
    } catch {
      continue;
    }
    if (key === 'confirm') confirmations.push(separator < 0 ? '' : parameter.slice(separator + 1));
  }
  if (
    confirmations.length > 0
    && (confirmations.length !== 1 || confirmations[0] !== targetName)
  ) {
    throw new RegistryRequestError(
      400,
      `Cascade deletion requires confirm=${targetName} exactly; confirm=true is not accepted`,
    );
  }
}

export function authorizeRegistryBody(bytes: Buffer, method: string, principal: AuthPrincipal): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RegistryRequestError(400, 'Invalid namespace JSON body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RegistryRequestError(400, 'Namespace body must be an object');
  }
  const body = value as Record<string, unknown>;
  const hasName = Object.hasOwn(body, 'name');
  if ((method === 'POST' || hasName) && (typeof body.name !== 'string' || !NAME_PATTERN.test(body.name))) {
    throw new RegistryRequestError(400, 'Invalid namespace name');
  }
  if (hasName && !registryNameAllowed(principal, body.name as string)) {
    throw new RegistryRequestError(403, 'Namespace access denied');
  }
  if (Object.hasOwn(body, 'description') && body.description !== null
    && typeof body.description !== 'string') {
    throw new RegistryRequestError(400, 'Invalid namespace description');
  }
  // Edge trims descriptions and counts Unicode scalar values, not UTF-8 bytes.
  if (typeof body.description === 'string') {
    const characters = [...body.description];
    if (characters.some((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    })) throw new RegistryRequestError(400, 'Invalid namespace description');
    // Rust str::trim uses Unicode White_Space (unlike JS trim, which also
    // strips BOM and does not strip NEXT LINE).
    const trimmed = body.description.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if ([...trimmed].length > 1024) {
      throw new RegistryRequestError(400, 'Namespace description exceeds 1024 characters');
    }
  }
  // Forward exactly the inspected meaning, including omission vs null. This
  // also removes duplicate JSON keys before another parser sees the body.
  return JSON.stringify({
    ...(hasName && { name: body.name }),
    ...(Object.hasOwn(body, 'description') && { description: body.description }),
  });
}

export function registryPagination(query: URLSearchParams): { offset: bigint; limit: number } {
  let offset = 0n;
  let limit = 100;
  for (const [key, value] of query) {
    if (key !== 'offset' && key !== 'limit') continue;
    if (!/^\+?\d+(?![\s\S])/.test(value)) {
      throw new RegistryRequestError(400, `Invalid ${key} pagination parameter`);
    }
    const parsed = BigInt(value);
    if (parsed > (key === 'offset' ? 9223372036854775807n : 18446744073709551615n)) {
      throw new RegistryRequestError(400, `Invalid ${key} pagination parameter`);
    }
    if (key === 'offset') offset = parsed;
    else limit = parsed === 0n ? 100 : Number(parsed > 1000n ? 1000n : parsed);
  }
  return { offset, limit };
}

async function readPage(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing namespace list body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > PAGE_BYTES) throw new Error('Namespace list page exceeds limit');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** The shared traversal outlived its own deadline; no waiter may see a partial list. */
export class NamespaceScanTimeoutError extends Error {
  constructor() {
    super('Namespace list scan exceeded its deadline');
    this.name = 'NamespaceScanTimeoutError';
  }
}

export interface ScopedListOptions {
  /** Upstream pages one traversal may read before it reports unavailable. */
  maxPages: number;
  /** Bound on the shared traversal itself, independent of any one waiter. */
  deadline: number;
  /**
   * Everything besides the URL and grants that shapes the upstream answer:
   * the signing subject and role and the forwarded headers. Requests that
   * agree on it, the URL, and the grants share one traversal.
   */
  identity: string;
  /** The waiting request's own cancellation (deadline or disconnect). */
  signal: AbortSignal;
}

type ScanOutcome =
  | { names: string[] }
  | { status: number; body: Record<string, string> };

interface SharedScan {
  outcome: Promise<ScanOutcome>;
  controller: AbortController;
  waiters: number;
}

const sharedScans = new Map<string, SharedScan>();

/** In-flight traversals and the requests waiting on them, for diagnostics and tests. */
export function sharedScanStats(): { scans: number; waiters: number } {
  let waiters = 0;
  for (const scan of sharedScans.values()) waiters += scan.waiters;
  return { scans: sharedScans.size, waiters };
}

function unavailable(outcome: Extract<ScanOutcome, { status: number }>): Response {
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Filtering individual pages leaves gaps and exposes the fleet total, so the
// traversal retains only granted names and the caller paginates that set. Its
// cost is bounded three ways: it stops as soon as every grant is found (the
// result is a subset of the grants, so no later page can change it), it reads
// at most `maxPages` pages and otherwise reports the list unavailable rather
// than partial, and it runs under its own deadline.
async function scanGrantedNames(
  target: URL,
  grants: ReadonlySet<string>,
  fetchPage: (url: URL, signal: AbortSignal) => Promise<Response>,
  maxPages: number,
  signal: AbortSignal,
): Promise<ScanOutcome> {
  const names = new Set<string>();
  let upstreamOffset = 0;
  let pages = 0;
  while (true) {
    if (pages >= maxPages) {
      return {
        status: 503,
        body: { error: 'Namespace list unavailable', code: 'FERRUM_BFF_NAMESPACE_SCAN_BUDGET' },
      };
    }
    const pageUrl = new URL(target);
    pageUrl.searchParams.set('offset', String(upstreamOffset));
    pageUrl.searchParams.set('limit', String(PAGE_SIZE));
    const response = await fetchPage(pageUrl, signal);
    pages += 1;
    if (response.status !== 200) {
      await response.body?.cancel();
      // Never forward a partial list or an upstream error body containing
      // names outside the grant set.
      return {
        status: response.status >= 400 ? response.status : 502,
        body: { error: 'Namespace list unavailable' },
      };
    }
    const page: unknown = await readPage(response);
    const legacy = Array.isArray(page);
    const envelope = page as { data?: unknown; pagination?: { offset?: unknown; total?: unknown } } | null;
    const data = legacy ? page : envelope?.data;
    if (!Array.isArray(data) || data.some((name) => typeof name !== 'string' || !NAME_PATTERN.test(name))) {
      throw new Error('Invalid namespace list');
    }
    for (const name of data as string[]) if (grants.has(name)) names.add(name);
    if (legacy) break;
    const total = envelope?.pagination?.total;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
      || envelope?.pagination?.offset !== upstreamOffset || data.length > PAGE_SIZE) {
      throw new Error('Invalid namespace pagination');
    }
    upstreamOffset += data.length;
    if (upstreamOffset >= total) break;
    // The first page always runs, so the gateway's own answer (including a
    // refusal) still decides a request whose grants are all found.
    if (names.size === grants.size) break;
    if (data.length === 0) throw new Error('Namespace pagination made no progress');
  }
  return { names: [...names].sort() };
}

function startScan(key: string, deadline: number, run: (signal: AbortSignal) => Promise<ScanOutcome>): SharedScan {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NamespaceScanTimeoutError()), deadline);
  timer.unref();
  const scan = { controller, waiters: 0 } as SharedScan;
  scan.outcome = run(controller.signal)
    .catch((error: unknown) => {
      // An aborted fetch or body read reports its own error shape; report why
      // the traversal was stopped instead.
      throw controller.signal.aborted ? controller.signal.reason : error;
    })
    .finally(() => {
      clearTimeout(timer);
      if (sharedScans.get(key) === scan) sharedScans.delete(key);
    });
  // Every waiter observes the outcome itself; this only keeps an abandoned
  // traversal's rejection from surfacing as unhandled.
  scan.outcome.catch(() => undefined);
  sharedScans.set(key, scan);
  return scan;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Identical concurrent lists join one in-flight traversal instead of each
// walking the registry. A waiter that gives up leaves the traversal to the
// others; the last one to leave stops it, so no upstream read outlives every
// request that wanted it. No result is kept once the traversal settles.
async function joinScan(
  key: string,
  options: ScopedListOptions,
  run: (signal: AbortSignal) => Promise<ScanOutcome>,
): Promise<ScanOutcome> {
  const scan = sharedScans.get(key) ?? startScan(key, options.deadline, run);
  scan.waiters += 1;
  try {
    return await untilAborted(scan.outcome, options.signal);
  } finally {
    scan.waiters -= 1;
    if (scan.waiters === 0) {
      if (sharedScans.get(key) === scan) sharedScans.delete(key);
      scan.controller.abort(new Error('Namespace list scan abandoned'));
    }
  }
}

// No upstream cache validators or lengths describe this caller-specific
// representation.
export async function scopedRegistryList(
  target: URL,
  principal: AuthPrincipal,
  fetchPage: (url: URL, signal: AbortSignal) => Promise<Response>,
  options: ScopedListOptions,
): Promise<Response> {
  const { offset, limit } = registryPagination(target.searchParams);
  const grants = new Set(principal.namespaces);
  const scope = new URL(target);
  scope.searchParams.delete('offset');
  scope.searchParams.delete('limit');
  const key = JSON.stringify([scope.href, [...grants].sort(), options.identity]);
  const outcome = await joinScan(key, options, (signal) => (
    scanGrantedNames(target, grants, fetchPage, options.maxPages, signal)
  ));
  if (!('names' in outcome)) return unavailable(outcome);
  const sorted = outcome.names;
  const start = offset > BigInt(sorted.length) ? sorted.length : Number(offset);
  // Keep the full int64 offset in the wire JSON instead of rounding it through
  // a JS Number. The collection itself is bounded by the principal's grants.
  return new Response(`{"data":${JSON.stringify(sorted.slice(start, start + limit))},"pagination":{"offset":${offset},"limit":${limit},"total":${sorted.length}}}`, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
