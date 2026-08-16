/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TLS management API (types + endpoints)           */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type { PaginatedResponse, PaginationParams } from "./types";

/* ---------- Inventory ---------- */

export type TlsMaterialKind =
  | "certificate"
  | "private_key"
  | "ca_bundle"
  | "crl"
  | "jwks"
  | "ocsp"
  | "unknown";

export interface TlsInventorySource {
  kind: string;
  identifier: string;
  refreshable: boolean;
  version?: string;
}

export interface TlsInventoryUsage {
  surface: string;
  role: string;
  resource_type: string;
  resource_id: string;
  field: string;
}

export interface TlsInventoryEntry {
  id: string;
  material_kind: TlsMaterialKind;
  source: TlsInventorySource;
  state: "loaded" | "unsupported" | "unavailable" | "invalid";
  used_by: TlsInventoryUsage[];
  subject?: string;
  issuer?: string;
  sans?: string[];
  not_before?: string;
  not_after?: string;
  days_until_expiry?: number;
  fingerprint_sha256?: string;
  certificate_count?: number;
  crl_count?: number;
  error?: string;
}

/* ---------- Events ---------- */

export interface TlsSourceEventMaterial {
  label: string;
  cert_id: string;
  source_id: string;
  scheme: string;
  kind: string;
  fingerprint_sha256?: string;
}

export interface TlsSourceEvent {
  id: number;
  at: string;
  surface: string;
  outcome: "rotated" | "load_error" | "rebuild_error";
  sources: TlsSourceEventMaterial[];
  revision?: number;
  error?: string;
}

export interface TlsEventsParams extends PaginationParams {
  cert_id?: string;
  source_id?: string;
  surface?: string;
  outcome?: "rotated" | "load_error" | "rebuild_error";
  since?: string;
}

/* ---------- Managed records ---------- */

export type ManagedTlsKind =
  | "certificate"
  | "ca_bundle"
  | "crl"
  | "ocsp_response"
  | "jwks";

export interface ManagedTlsRecord {
  id: string;
  name: string;
  description?: string;
  kind: ManagedTlsKind;
  source_uri: string;
  subject?: string;
  issuer?: string;
  sans?: string[];
  not_before?: string;
  not_after?: string;
  fingerprint_sha256?: string;
  certificate_count?: number;
  crl_count?: number;
  byte_length?: number;
  created_at: string;
  updated_at: string;
}

export interface ManagedTlsCertificateRequest {
  id?: string;
  name?: string;
  description?: string;
  cert_pem: string;
  key_pem: string;
  chain_pem?: string;
  allow_overwrite?: boolean;
  allow_expired?: boolean;
  cert_expiry_warning_days?: number;
}

export interface ManagedTlsCaBundleRequest {
  id?: string;
  name?: string;
  description?: string;
  ca_bundle_pem: string;
  allow_overwrite?: boolean;
  allow_expired?: boolean;
  cert_expiry_warning_days?: number;
}

export interface ManagedTlsCrlRequest {
  id?: string;
  name?: string;
  description?: string;
  crl_pem: string;
  allow_overwrite?: boolean;
}

export interface ManagedTlsOcspResponseRequest {
  id?: string;
  name?: string;
  description?: string;
  ocsp_der_base64: string;
  allow_overwrite?: boolean;
}

export interface ManagedTlsJwksRequest {
  id?: string;
  name?: string;
  description?: string;
  jwks_json: string;
  allow_overwrite?: boolean;
}

export type ManagedTlsRequest =
  | ManagedTlsCertificateRequest
  | ManagedTlsCaBundleRequest
  | ManagedTlsCrlRequest
  | ManagedTlsOcspResponseRequest
  | ManagedTlsJwksRequest;

/** Collection slug for each managed record kind. */
export const MANAGED_TLS_COLLECTIONS = {
  certificate: "certificates",
  ca_bundle: "ca-bundles",
  crl: "crls",
  ocsp_response: "ocsp-responses",
  jwks: "jwks",
} as const satisfies Record<ManagedTlsKind, string>;

export type ManagedTlsCollection =
  (typeof MANAGED_TLS_COLLECTIONS)[ManagedTlsKind];

/* ---------- ACME ---------- */

export interface AcmeCertificateRecord {
  id: string;
  domains: string[];
  directory_url: string;
  account_id?: string;
  order_url?: string;
  status: "issued" | "renewing" | "failed" | "revoked";
  source_uri: string;
  subject?: string;
  issuer?: string;
  sans?: string[];
  not_before?: string;
  not_after?: string;
  fingerprint_sha256?: string;
  certificate_count?: number;
  byte_length?: number;
  issued_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AcmeCertificateRequest {
  id?: string;
  domains: string[];
  directory_url: string;
  account_id?: string;
  order_url?: string;
  cert_pem: string;
  key_pem: string;
  chain_pem?: string;
  allow_overwrite?: boolean;
  allow_expired?: boolean;
  cert_expiry_warning_days?: number;
}

export interface AcmeHttp01Challenge {
  identifier: string;
  token: string;
  key_authorization: string;
  path: string;
}

export interface AcmeTlsAlpn01Challenge {
  identifier: string;
  token: string;
  key_authorization_sha256_base64url: string;
  alpn_protocol: "acme-tls/1";
}

export interface AcmeDns01Challenge {
  identifier: string;
  token: string;
  txt_record_name: string;
  txt_value: string;
}

export type AcmeOrderStatus =
  | "pending_challenges"
  | "ready"
  | "processing"
  | "valid"
  | "failed"
  | "cancelled";

export interface AcmeOrder {
  id: string;
  certificate_id?: string;
  domains: string[];
  directory_url: string;
  account_id?: string;
  order_url?: string;
  status: AcmeOrderStatus;
  http01_challenges?: AcmeHttp01Challenge[];
  tls_alpn01_challenges?: AcmeTlsAlpn01Challenge[];
  dns01_challenges?: AcmeDns01Challenge[];
  error?: string;
  created_at: string;
  updated_at: string;
}

export type AcmeChallengeType = "http01" | "tls_alpn01" | "dns01";

export interface AcmeOrderRequest {
  id?: string;
  certificate_id?: string;
  domains: string[];
  directory_url: string;
  contact?: string[];
  terms_of_service_agreed?: boolean;
  challenge_type?: AcmeChallengeType;
  existing_account_credentials_json?: string;
  allow_overwrite?: boolean;
}

export interface AcmeOrderFinalizeRequest {
  certificate_id?: string;
  poll_timeout_seconds?: number;
  allow_overwrite?: boolean;
  allow_expired?: boolean;
  cert_expiry_warning_days?: number;
}

export interface AcmeOrderFinalizeResponse {
  order: AcmeOrder;
  certificate: AcmeCertificateRecord;
}

export interface AcmeRenewRequest {
  id?: string;
  contact?: string[];
  terms_of_service_agreed?: boolean;
  challenge_type?: AcmeChallengeType;
  existing_account_credentials_json?: string;
  allow_overwrite?: boolean;
}

export interface AcmeAccount {
  account_id: string;
  directory_url: string;
  order_count: number;
  certificate_count: number;
  has_persisted_credentials: boolean;
  last_order_at?: string;
  last_certificate_updated_at?: string;
}

/* ---------- Rotate / validate ---------- */

export type TlsRotateSurface =
  | "proxy_https"
  | "backend_tls"
  | "admin_https"
  | "dtls"
  | "database_tls"
  | "cp_grpc"
  | "dp_grpc"
  | "svid"
  | "all";

export interface TlsRotateAcceptedResponse {
  accepted?: boolean;
  requested_surface?: string;
  surface?: string;
  surfaces?: string[];
  gateway_svid_revision?: number;
}

export interface TlsValidateRequest {
  cert_pem?: string;
  key_pem?: string;
  ca_bundle_pem?: string;
  crl_pem?: string;
  allow_expired?: boolean;
  cert_expiry_warning_days?: number;
}

export interface TlsValidateResponse {
  valid: boolean;
  validated: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  API functions                                                      */
/* ------------------------------------------------------------------ */

function paginationSearch(params: PaginationParams): Record<string, string> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);
  return searchParams;
}

/* ---------- Inventory & events ---------- */

export async function listInventory(
  params: PaginationParams = {},
): Promise<PaginatedResponse<TlsInventoryEntry>> {
  return proxyApi
    .get("admin/tls/inventory", { searchParams: paginationSearch(params) })
    .json<PaginatedResponse<TlsInventoryEntry>>();
}

export async function listEvents(
  params: TlsEventsParams = {},
): Promise<PaginatedResponse<TlsSourceEvent>> {
  const searchParams = paginationSearch(params);
  if (params.cert_id) searchParams.cert_id = params.cert_id;
  if (params.source_id) searchParams.source_id = params.source_id;
  if (params.surface) searchParams.surface = params.surface;
  if (params.outcome) searchParams.outcome = params.outcome;
  if (params.since) searchParams.since = params.since;
  return proxyApi
    .get("admin/tls/events", { searchParams })
    .json<PaginatedResponse<TlsSourceEvent>>();
}

/* ---------- Managed records (generic across the five collections) -- */

export async function listManagedRecords(
  collection: ManagedTlsCollection,
  params: PaginationParams = {},
): Promise<PaginatedResponse<ManagedTlsRecord>> {
  return proxyApi
    .get(`admin/tls/${collection}`, { searchParams: paginationSearch(params) })
    .json<PaginatedResponse<ManagedTlsRecord>>();
}

export async function createManagedRecord(
  collection: ManagedTlsCollection,
  data: ManagedTlsRequest,
): Promise<ManagedTlsRecord> {
  return proxyApi
    .post(`admin/tls/${collection}`, { json: data })
    .json<ManagedTlsRecord>();
}

export async function updateManagedRecord(
  collection: ManagedTlsCollection,
  id: string,
  data: ManagedTlsRequest,
): Promise<ManagedTlsRecord> {
  return proxyApi
    .put(`admin/tls/${collection}/${id}`, { json: data })
    .json<ManagedTlsRecord>();
}

export async function removeManagedRecord(
  collection: ManagedTlsCollection,
  id: string,
): Promise<void> {
  await proxyApi.delete(`admin/tls/${collection}/${id}`);
}

/* ---------- ACME ---------- */

export async function listAcmeCertificates(
  params: PaginationParams = {},
): Promise<PaginatedResponse<AcmeCertificateRecord>> {
  return proxyApi
    .get("admin/tls/acme/certificates", {
      searchParams: paginationSearch(params),
    })
    .json<PaginatedResponse<AcmeCertificateRecord>>();
}

export async function createAcmeCertificate(
  data: AcmeCertificateRequest,
): Promise<AcmeCertificateRecord> {
  return proxyApi
    .post("admin/tls/acme/certificates", { json: data })
    .json<AcmeCertificateRecord>();
}

export async function removeAcmeCertificate(id: string): Promise<void> {
  await proxyApi.delete(`admin/tls/acme/certificates/${id}`);
}

export async function listAcmeOrders(
  params: PaginationParams = {},
): Promise<PaginatedResponse<AcmeOrder>> {
  return proxyApi
    .get("admin/tls/acme/orders", { searchParams: paginationSearch(params) })
    .json<PaginatedResponse<AcmeOrder>>();
}

export async function createAcmeOrder(
  data: AcmeOrderRequest,
): Promise<AcmeOrder> {
  return proxyApi.post("admin/tls/acme/orders", { json: data }).json<AcmeOrder>();
}

export async function removeAcmeOrder(id: string): Promise<void> {
  await proxyApi.delete(`admin/tls/acme/orders/${id}`);
}

export async function finalizeAcmeOrder(
  id: string,
  data: AcmeOrderFinalizeRequest = {},
): Promise<AcmeOrderFinalizeResponse> {
  return proxyApi
    .post(`admin/tls/acme/orders/${id}/finalize`, { json: data })
    .json<AcmeOrderFinalizeResponse>();
}

export async function renewAcmeCertificate(
  id: string,
  data: AcmeRenewRequest = {},
): Promise<AcmeOrder> {
  return proxyApi
    .post(`admin/tls/acme/renew/${id}`, { json: data })
    .json<AcmeOrder>();
}

export async function listAcmeAccounts(
  params: PaginationParams = {},
): Promise<PaginatedResponse<AcmeAccount>> {
  return proxyApi
    .get("admin/tls/acme/accounts", { searchParams: paginationSearch(params) })
    .json<PaginatedResponse<AcmeAccount>>();
}

/* ---------- Rotate / validate ---------- */

export async function rotateSurface(
  surface: TlsRotateSurface,
): Promise<TlsRotateAcceptedResponse> {
  return proxyApi
    .post(`admin/tls/rotate/${surface}`)
    .json<TlsRotateAcceptedResponse>();
}

export async function validateMaterial(
  data: TlsValidateRequest,
): Promise<TlsValidateResponse> {
  return proxyApi
    .post("admin/tls/validate", { json: data })
    .json<TlsValidateResponse>();
}
