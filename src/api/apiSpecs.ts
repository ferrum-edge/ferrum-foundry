/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – API spec import endpoints (types + functions)    */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";

export interface ApiSpecSummary {
  id: string;
  proxy_id: string;
  namespace: string;
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
  content_encoding: "gzip";
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
  params: ApiSpecListParams = {},
): Promise<ApiSpecListResponse> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams[key] = String(value);
  }
  return proxyApi
    .get("api-specs", { searchParams })
    .json<ApiSpecListResponse>();
}

/** Fetch every API spec without imposing a silent UI-side record cap. */
export async function listAll(): Promise<ApiSpecSummary[]> {
  const items: ApiSpecSummary[] = [];
  let offset = 0;
  const limit = 250;
  let expectedTotal: number | undefined;

  for (;;) {
    const page = await list({ offset, limit });
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
export async function getDocument(id: string): Promise<string> {
  return proxyApi
    .get(`api-specs/${id}`, { headers: { accept: "application/yaml" } })
    .text();
}

function specBodyOptions(document: string): {
  body: string;
  headers: Record<string, string>;
} {
  const isJson = document.trimStart().startsWith("{");
  return {
    body: document,
    headers: {
      "content-type": isJson ? "application/json" : "application/yaml",
    },
  };
}

/** Import a spec document (YAML or JSON text), creating proxy/upstream/plugins. */
export async function create(document: string): Promise<ApiSpecCreateResponse> {
  return proxyApi
    .post("api-specs", specBodyOptions(document))
    .json<ApiSpecCreateResponse>();
}

/** Replace a spec's document and its spec-owned resources. */
export async function update(
  id: string,
  document: string,
): Promise<ApiSpecCreateResponse> {
  return proxyApi
    .put(`api-specs/${id}`, specBodyOptions(document))
    .json<ApiSpecCreateResponse>();
}

/** Delete the spec and cascade its proxy, plugins, and spec-owned upstream. */
export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`api-specs/${id}`);
}
