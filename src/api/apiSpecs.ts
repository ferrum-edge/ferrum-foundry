/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – API spec import endpoints (types + functions)    */
/* ------------------------------------------------------------------ */

import { isHTTPError } from 'ky';
import { proxyApi, scoped, SILENT_ERRORS, extractApiErrorData, type NamespaceScope } from "./client";
import { longRunningClientTimeout } from '../../server/waitBudget';
import { observeMutation } from './mutationOutcome';

const readOptions = { timeout: longRunningClientTimeout('GET', '/api-specs'), retry: 0 };

export interface ApiSpecSummary {
  id: string;
  proxy_id: string;
  spec_version: string;
  spec_format: "json" | "yaml";
  title: string | null;
  info_version: string | null;
  description: string | null;
  contact_name: string | null;
  contact_email: string | null;
  license_name: string | null;
  license_identifier: string | null;
  tags: string[];
  server_urls: string[];
  operation_count: number;
  uncompressed_size: number;
  content_hash: string;
  external_ref_digest?: string | null;
  created_at: string;
  updated_at: string;
}

/** NOTE: api-specs uses items/next_offset, not the data/pagination envelope. */
export interface ApiSpecListResponse {
  items: ApiSpecSummary[];
  limit: number;
  offset: number;
  next_offset: number | null;
  total: number;
}

export interface ApiSpecCreateResponse {
  id: string;
  proxy_id: string;
  spec_version: string;
  content_hash: string;
}

export interface ApiSpecValidationFailure {
  resource_type: string;
  id?: string;
  errors: string[];
}

export interface ApiSpecValidationError {
  error: string;
  spec_version?: string;
  failures: ApiSpecValidationFailure[];
}

export interface ApiSpecParseError {
  error: string;
  code: string;
  details: string;
}

export interface ApiSpecListParams {
  offset?: number;
  limit?: number;
  proxy_id?: string;
  spec_version?: string;
  title_contains?: string;
  updated_since?: string;
  has_tag?: string;
  sort_by?: "updated_at" | "title" | "operation_count" | "created_at";
  order?: "asc" | "desc";
}

export async function list(
  scope: NamespaceScope,
  params: ApiSpecListParams = {},
): Promise<ApiSpecListResponse> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams[key] = String(value);
  }
  return proxyApi
    .get("api-specs", scoped(scope, { ...readOptions, searchParams }))
    .json<ApiSpecListResponse>();
}

/** Summary lookup uses the filtered list: by-proxy returns a raw document,
 * not a list or a metadata record, and does not carry the spec UUID.
 * (namespace, proxy_id) is unique upstream. Never substitute proxy_id for id.
 */
export async function listByProxy(scope: NamespaceScope, proxyId: string): Promise<ApiSpecSummary[]> {
  const page = await list(scope, { proxy_id: proxyId, offset: 0, limit: 2 });
  if (!Array.isArray(page.items) || page.total !== page.items.length || page.items.length > 1 ||
      page.offset !== 0 || page.next_offset !== null ||
      page.items.some(item => !item || typeof item.id !== 'string' || !item.id || item.proxy_id !== proxyId)) {
    throw new Error('Gateway returned inconsistent API spec binding metadata');
  }
  return page.items;
}

/** The actual by-proxy endpoint negotiates raw YAML, like GET /api-specs/{id}.
 * A documented 404 means no binding, including a binding removed since listing.
 * Other failures remain errors; a failed read must not look like an empty spec.
 */
export async function getDocumentByProxy(scope: NamespaceScope, proxyId: string): Promise<string | null> {
  try {
    const response = await proxyApi.get(`api-specs/by-proxy/${encodeURIComponent(proxyId)}`,
      scoped(scope, { ...readOptions, headers: { accept: 'application/yaml' } }));
    const document = await response.text();
    if (!response.headers.get('content-type')?.includes('yaml') || !document.trim()) {
      throw new Error('Gateway returned an invalid bound spec document response');
    }
    return document;
  } catch (error) {
    if (isHTTPError(error) && error.response.status === 404 &&
        extractApiErrorData(error.data) === 'API spec not found') return null;
    throw error;
  }
}

/**
 * Fetch every API spec without imposing a silent UI-side record cap. Every
 * page is fetched under `scope`, however long the collection takes.
 */
export async function listAll(scope: NamespaceScope): Promise<ApiSpecSummary[]> {
  const items: ApiSpecSummary[] = [];
  let offset = 0;
  const limit = 250;
  let expectedTotal: number | undefined;

  for (;;) {
    const page = await list(scope, { offset, limit });
    if (
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      !Number.isSafeInteger(page.offset) ||
      page.offset !== offset
    ) {
      throw new Error("Gateway returned inconsistent API spec pagination metadata");
    }
    if (expectedTotal === undefined) {
      expectedTotal = page.total;
    } else if (page.total !== expectedTotal) {
      throw new Error("Gateway changed API spec pagination total while collecting pages");
    }
    items.push(...page.items);
    if (items.length >= expectedTotal) {
      if (items.length !== expectedTotal) {
        throw new Error("Gateway returned more API specs than its pagination total");
      }
      return items;
    }
    if (page.items.length === 0 || page.next_offset == null) {
      throw new Error("API spec pagination stopped advancing before completion");
    }
    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) {
      throw new Error("Gateway returned a non-advancing API spec cursor");
    }
    offset = page.next_offset;
  }
}

/** Fetch the raw stored spec document as YAML text. */
export async function getDocument(
  scope: NamespaceScope,
  id: string,
): Promise<string> {
  return proxyApi
    .get(
      `api-specs/${id}`,
      scoped(scope, { ...readOptions, headers: { accept: "application/yaml" } }),
    )
    .text();
}

function specBodyOptions(document: string): {
  body: string;
  headers: Record<string, string>;
  timeout: number;
  retry: number;
  context: Record<string, unknown>;
} {
  const isJson = document.trimStart().startsWith("{");
  return {
    body: document,
    timeout: longRunningClientTimeout('POST', '/api-specs'),
    retry: 0,
    context: { [SILENT_ERRORS]: true },
    headers: {
      "content-type": isJson ? "application/json" : "application/yaml",
    },
  };
}

/** Import a spec document (YAML or JSON text), creating proxy/upstream/plugins. */
export async function create(
  scope: NamespaceScope,
  document: string,
): Promise<ApiSpecCreateResponse> {
  return observeMutation(
    'Spec import',
    proxyApi
      .post('api-specs', scoped(scope, specBodyOptions(document)))
      .json<ApiSpecCreateResponse>(),
  );
}

/** Replace a spec's document and its spec-owned resources. */
export async function update(
  scope: NamespaceScope,
  id: string,
  document: string,
): Promise<ApiSpecCreateResponse> {
  return observeMutation(
    'Spec replacement',
    proxyApi
      .put(`api-specs/${id}`, scoped(scope, specBodyOptions(document)))
      .json<ApiSpecCreateResponse>(),
  );
}

/** Delete the spec and cascade its proxy, plugins, and spec-owned upstream. */
export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await proxyApi.delete(`api-specs/${id}`, scoped(scope, readOptions));
}
