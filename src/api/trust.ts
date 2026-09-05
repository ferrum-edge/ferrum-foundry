/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Gateway trust bundle API (types + functions)     */
/* ------------------------------------------------------------------ */

import {
  SILENT_ERRORS,
  proxyApi,
  scoped,
  type NamespaceScope,
} from "./client";
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

export interface GatewayTrustRevisionConflict {
  error: string;
  expected_revision: number;
  current_revision: number;
}

export function getGatewayTrustRevisionConflict(
  error: unknown,
): GatewayTrustRevisionConflict | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { response?: { status?: unknown }; data?: unknown };
  if (candidate.response?.status !== 409 || !candidate.data || typeof candidate.data !== "object") {
    return null;
  }
  const body = candidate.data as Record<string, unknown>;
  if (
    typeof body.error !== "string" ||
    !Number.isSafeInteger(body.expected_revision) ||
    !Number.isSafeInteger(body.current_revision)
  ) {
    return null;
  }
  return {
    error: body.error,
    expected_revision: body.expected_revision as number,
    current_revision: body.current_revision as number,
  };
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
): Promise<PaginatedResponse<GatewayTrustBundle>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);
  return proxyApi
    .get("gateway-trust-bundles", scoped(scope, { searchParams }))
    .json<PaginatedResponse<GatewayTrustBundle>>();
}

export async function get(
  scope: NamespaceScope,
  id: string,
): Promise<GatewayTrustBundle> {
  return proxyApi
    .get(`gateway-trust-bundles/${id}`, scoped(scope))
    .json<GatewayTrustBundle>();
}

export async function create(
  scope: NamespaceScope,
  data: GatewayTrustBundleCreate,
): Promise<GatewayTrustBundle> {
  return proxyApi
    .post(
      "gateway-trust-bundles",
      scoped(scope, { json: data, context: { [SILENT_ERRORS]: true } }),
    )
    .json<GatewayTrustBundle>();
}

export async function update(
  scope: NamespaceScope,
  id: string,
  data: GatewayTrustBundleCreate,
): Promise<GatewayTrustBundle> {
  return proxyApi
    .put(
      `gateway-trust-bundles/${id}`,
      scoped(scope, { json: data, context: { [SILENT_ERRORS]: true } }),
    )
    .json<GatewayTrustBundle>();
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await proxyApi.delete(
    `gateway-trust-bundles/${id}`,
    scoped(scope, { context: { [SILENT_ERRORS]: true } }),
  );
}

export async function status(
  scope: NamespaceScope,
): Promise<GatewayTrustStatus> {
  return proxyApi
    .get("gateway-trust/status", scoped(scope))
    .json<GatewayTrustStatus>();
}
