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
