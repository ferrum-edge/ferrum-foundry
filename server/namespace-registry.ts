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

// Filtering individual pages leaves gaps and exposes the fleet total. Scan
// with a fixed page bound under the caller's single response deadline, retain
// only granted names, then paginate that set. No upstream cache validators or
// lengths describe this caller-specific representation.
export async function scopedRegistryList(
  target: URL,
  principal: AuthPrincipal,
  fetchPage: (url: URL) => Promise<Response>,
): Promise<Response> {
  const { offset, limit } = registryPagination(target.searchParams);
  const grants = new Set(principal.namespaces);
  const names = new Set<string>();
  let upstreamOffset = 0;
  while (true) {
    const pageUrl = new URL(target);
    pageUrl.searchParams.set('offset', String(upstreamOffset));
    pageUrl.searchParams.set('limit', String(PAGE_SIZE));
    const response = await fetchPage(pageUrl);
    if (response.status !== 200) {
      await response.body?.cancel();
      // Never forward a partial list or an upstream error body containing
      // names outside the grant set.
      return new Response(JSON.stringify({ error: 'Namespace list unavailable' }), {
        status: response.status >= 400 ? response.status : 502,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
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
    if (data.length === 0) throw new Error('Namespace pagination made no progress');
  }
  const sorted = [...names].sort();
  const start = offset > BigInt(sorted.length) ? sorted.length : Number(offset);
  // Keep the full int64 offset in the wire JSON instead of rounding it through
  // a JS Number. The collection itself is bounded by the principal's grants.
  return new Response(`{"data":${JSON.stringify(sorted.slice(start, start + limit))},"pagination":{"offset":${offset},"limit":${limit},"total":${sorted.length}}}`, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
