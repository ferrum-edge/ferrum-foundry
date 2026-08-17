/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Gateway trust bundle API (types + functions)     */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type { PaginatedResponse, PaginationParams } from "./types";

export interface TrustBundleJwtAuthority {
  key_id: string;
  public_key_pem: string;
}

export interface TrustBundle {
  trust_domain: string;
  x509_authorities?: string[];
  jwt_authorities?: TrustBundleJwtAuthority[];
  refresh_hint_seconds?: number;
}

export interface GatewayTrustBundleSet {
  local: TrustBundle;
  federated?: TrustBundle[];
}

export interface GatewayTrustBundle {
  id: string;
  namespace: string;
  trust_domain: string;
  bundle: GatewayTrustBundleSet;
  revision: number;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GatewayTrustBundleCreate {
  id?: string;
  trust_domain: string;
  bundle: GatewayTrustBundleSet;
  /** Expected current revision on PUT (0/omit skips the check). */
  revision?: number;
}

export interface GatewayTrustBundleSummary {
  namespace: string;
  trust_domain: string;
  revision: number;
  x509_authority_count: number;
  jwt_authority_count: number;
  federated_count: number;
  updated_at: string;
}

export interface GatewayTrustStatus {
  namespace: string;
  configured: boolean;
  authority_unresolved: boolean;
  generation: string;
  bundle?: GatewayTrustBundleSummary | null;
  process: {
    published_generations_total: number;
    load_rejections_total: number;
    ambiguous_authority_total: number;
    last_published_unix_seconds: number;
    last_failure_reason:
      | "none"
      | "invalid_material"
      | "undecodable"
      | "ambiguous_authority";
  };
}

export async function list(
  params: PaginationParams = {},
): Promise<PaginatedResponse<GatewayTrustBundle>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);
  return proxyApi
    .get("gateway-trust-bundles", { searchParams })
    .json<PaginatedResponse<GatewayTrustBundle>>();
}

export async function create(
  data: GatewayTrustBundleCreate,
): Promise<GatewayTrustBundle> {
  return proxyApi
    .post("gateway-trust-bundles", { json: data })
    .json<GatewayTrustBundle>();
}

export async function update(
  id: string,
  data: GatewayTrustBundleCreate,
): Promise<GatewayTrustBundle> {
  return proxyApi
    .put(`gateway-trust-bundles/${id}`, { json: data })
    .json<GatewayTrustBundle>();
}

export async function remove(id: string): Promise<void> {
  await proxyApi.delete(`gateway-trust-bundles/${id}`);
}

export async function status(): Promise<GatewayTrustStatus> {
  return proxyApi.get("gateway-trust/status").json<GatewayTrustStatus>();
}
