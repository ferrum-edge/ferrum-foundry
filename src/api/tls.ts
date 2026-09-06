/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TLS management API (types + endpoints)           */
/* ------------------------------------------------------------------ */

import { FLEET_GLOBAL, SILENT_ERRORS, proxyApi } from "./client";
import type { PaginatedResponse, PaginationParams } from "./types";
import { collectAllPages } from "./pagination";
import { ACME_MAX_WAIT_MS, serverWaitTimeout } from "../../server/waitBudget";

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

/**
 * Request keys `POST /admin/tls/validate` can name in a `field: message`
 * validation error. `satisfies` keeps the list honest against the request
 * type: renaming a field upstream fails the build rather than silently
 * dropping an inline form error.
 */
export const TLS_VALIDATE_FIELDS = [
  "cert_pem",
  "key_pem",
  "ca_bundle_pem",
  "crl_pem",
  "allow_expired",
  "cert_expiry_warning_days",
] as const satisfies readonly (keyof TlsValidateRequest)[];

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

const FLEET_GLOBAL_CONTEXT = { [FLEET_GLOBAL]: true };

/**
 * Fleet-global, and the caller owns the failure.
 *
 * The gateway answers unusable operator-pasted material with a field-scoped
 * 400 (`{"error":"cert_pem: no PEM certificates found"}`). That is a form
 * validation result, not a fault to report: the form renders it under the
 * offending textarea, so the global "API Error" dialog must stay closed.
 */
const FLEET_GLOBAL_SILENT_CONTEXT = {
  [FLEET_GLOBAL]: true,
  [SILENT_ERRORS]: true,
};

/* ---------- Inventory & events ---------- */

export async function listInventory(
  params: PaginationParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<TlsInventoryEntry>> {
  return proxyApi
    .get("admin/tls/inventory", {
      searchParams: paginationSearch(params),
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<PaginatedResponse<TlsInventoryEntry>>();
}

export async function listEvents(
  params: TlsEventsParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<TlsSourceEvent>> {
  const searchParams = paginationSearch(params);
  if (params.cert_id) searchParams.cert_id = params.cert_id;
  if (params.source_id) searchParams.source_id = params.source_id;
  if (params.surface) searchParams.surface = params.surface;
  if (params.outcome) searchParams.outcome = params.outcome;
  if (params.since) searchParams.since = params.since;
  return proxyApi
    .get("admin/tls/events", { searchParams, context: { ...context, ...FLEET_GLOBAL_CONTEXT } })
    .json<PaginatedResponse<TlsSourceEvent>>();
}

/* ---------- Managed records (generic across the five collections) -- */

export async function listManagedRecords(
  collection: ManagedTlsCollection,
  params: PaginationParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<ManagedTlsRecord>> {
  return proxyApi
    .get(`admin/tls/${collection}`, {
      searchParams: paginationSearch(params),
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<PaginatedResponse<ManagedTlsRecord>>();
}

export async function listAllManagedRecords(
  collection: ManagedTlsCollection,
  context: Record<string, unknown> = {},
): Promise<ManagedTlsRecord[]> {
  return collectAllPages((offset, limit) =>
    listManagedRecords(collection, { offset, limit }, context),
  );
}

export async function createManagedRecord(
  collection: ManagedTlsCollection,
  data: ManagedTlsRequest,
): Promise<ManagedTlsRecord> {
  return proxyApi
    .post(`admin/tls/${collection}`, {
      json: data,
      context: FLEET_GLOBAL_SILENT_CONTEXT,
    })
    .json<ManagedTlsRecord>();
}

export async function updateManagedRecord(
  collection: ManagedTlsCollection,
  id: string,
  data: ManagedTlsRequest,
): Promise<ManagedTlsRecord> {
  return proxyApi
    .put(`admin/tls/${collection}/${id}`, { json: data, context: FLEET_GLOBAL_CONTEXT })
    .json<ManagedTlsRecord>();
}

export async function removeManagedRecord(
  collection: ManagedTlsCollection,
  id: string,
): Promise<void> {
  await proxyApi.delete(`admin/tls/${collection}/${id}`, { context: FLEET_GLOBAL_CONTEXT });
}

/* ---------- ACME ---------- */

export async function listAcmeCertificates(
  params: PaginationParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<AcmeCertificateRecord>> {
  return proxyApi
    .get("admin/tls/acme/certificates", {
      searchParams: paginationSearch(params),
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<PaginatedResponse<AcmeCertificateRecord>>();
}

export async function listAllAcmeCertificates(context: Record<string, unknown> = {}): Promise<AcmeCertificateRecord[]> {
  return collectAllPages((offset, limit) =>
    listAcmeCertificates({ offset, limit }, context),
  );
}

export async function createAcmeCertificate(
  data: AcmeCertificateRequest,
): Promise<AcmeCertificateRecord> {
  return proxyApi
    .post("admin/tls/acme/certificates", {
      json: data,
      context: FLEET_GLOBAL_CONTEXT,
    })
    .json<AcmeCertificateRecord>();
}

export async function getAcmeCertificate(
  id: string,
  context: Record<string, unknown> = {},
): Promise<AcmeCertificateRecord> {
  return proxyApi
    .get(`admin/tls/acme/certificates/${id}`, {
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<AcmeCertificateRecord>();
}

export async function updateAcmeCertificate(
  id: string,
  data: AcmeCertificateRequest,
): Promise<AcmeCertificateRecord> {
  return proxyApi
    .put(`admin/tls/acme/certificates/${id}`, {
      json: { ...data, id },
      context: FLEET_GLOBAL_CONTEXT,
    })
    .json<AcmeCertificateRecord>();
}

export async function removeAcmeCertificate(
  id: string,
): Promise<void> {
  await proxyApi.delete(`admin/tls/acme/certificates/${id}`, {
    context: FLEET_GLOBAL_CONTEXT,
  });
}

export async function listAcmeOrders(
  params: PaginationParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<AcmeOrder>> {
  return proxyApi
    .get("admin/tls/acme/orders", {
      searchParams: paginationSearch(params),
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<PaginatedResponse<AcmeOrder>>();
}

export async function listAllAcmeOrders(context: Record<string, unknown> = {}): Promise<AcmeOrder[]> {
  return collectAllPages((offset, limit) => listAcmeOrders({ offset, limit }, context));
}

export async function createAcmeOrder(
  data: AcmeOrderRequest,
): Promise<AcmeOrder> {
  return proxyApi
    .post("admin/tls/acme/orders", { json: data, context: FLEET_GLOBAL_CONTEXT })
    .json<AcmeOrder>();
}

export async function removeAcmeOrder(id: string): Promise<void> {
  await proxyApi.delete(`admin/tls/acme/orders/${id}`, { context: FLEET_GLOBAL_CONTEXT });
}

export class AcmeFinalizationUnknownError extends Error {
  constructor(readonly orderId: string, cause: unknown) {
    super(
      "Finalization may still be in progress; the result is unknown. Re-check order status before taking further action. Do not repeat finalization blindly.",
      { cause },
    );
    this.name = "AcmeFinalizationUnknownError";
  }
}

export async function getAcmeOrder(id: string): Promise<AcmeOrder> {
  return proxyApi
    .get(`admin/tls/acme/orders/${encodeURIComponent(id)}`, {
      context: FLEET_GLOBAL_CONTEXT,
    })
    .json<AcmeOrder>();
}

export async function finalizeAcmeOrder(
  id: string,
  data: AcmeOrderFinalizeRequest = {},
): Promise<AcmeOrderFinalizeResponse> {
  const seconds = data.poll_timeout_seconds ?? 60;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > ACME_MAX_WAIT_MS / 1000) {
    throw new RangeError("ACME polling budget must be an integer from 1 to 600 seconds.");
  }
  try {
    return await proxyApi
      .post(`admin/tls/acme/orders/${encodeURIComponent(id)}/finalize`, {
        json: { ...data, poll_timeout_seconds: seconds },
        timeout: serverWaitTimeout(seconds * 1000),
        retry: 0,
        context: { ...FLEET_GLOBAL_CONTEXT, [SILENT_ERRORS]: true },
      })
      .json<AcmeOrderFinalizeResponse>();
  } catch (error) {
    // A transport failure or upstream 5xx cannot prove the mutation stopped.
    const status = error instanceof Error && "response" in error
      ? (error as { response: Response }).response.status
      : undefined;
    if (status === undefined || status >= 500 || status === 408) {
      throw new AcmeFinalizationUnknownError(id, error);
    }
    throw error;
  }
}

export async function renewAcmeCertificate(
  id: string,
  data: AcmeRenewRequest = {},
): Promise<AcmeOrder> {
  return proxyApi
    .post(`admin/tls/acme/renew/${id}`, { json: data, context: FLEET_GLOBAL_CONTEXT })
    .json<AcmeOrder>();
}

export async function listAcmeAccounts(
  params: PaginationParams = {},
  context: Record<string, unknown> = {},
): Promise<PaginatedResponse<AcmeAccount>> {
  return proxyApi
    .get("admin/tls/acme/accounts", {
      searchParams: paginationSearch(params),
      context: { ...context, ...FLEET_GLOBAL_CONTEXT },
    })
    .json<PaginatedResponse<AcmeAccount>>();
}

export async function listAllAcmeAccounts(context: Record<string, unknown> = {}): Promise<AcmeAccount[]> {
  return collectAllPages((offset, limit) => listAcmeAccounts({ offset, limit }, context));
}

/* ---------- Rotate / validate ---------- */

export async function rotateSurface(
  surface: TlsRotateSurface,
): Promise<TlsRotateAcceptedResponse> {
  return proxyApi
    .post(`admin/tls/rotate/${surface}`, { context: FLEET_GLOBAL_CONTEXT })
    .json<TlsRotateAcceptedResponse>();
}

export async function validateMaterial(
  data: TlsValidateRequest,
): Promise<TlsValidateResponse> {
  return proxyApi
    .post("admin/tls/validate", {
      json: data,
      context: FLEET_GLOBAL_SILENT_CONTEXT,
    })
    .json<TlsValidateResponse>();
}
