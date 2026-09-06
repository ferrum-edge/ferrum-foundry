/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Namespace API functions                          */
/* ------------------------------------------------------------------ */

import {
  SILENT_ERRORS,
  proxyApi,
  scoped,
  type NamespaceScope,
} from "./client";
import type { PaginatedResponse } from "./types";
import { ALL_PAGE_SIZE, collectAllPages } from "./pagination";

// ── Types (mirror the upstream Namespace registry contract) ──────

export interface Namespace {
  name: string;
  /**
   * Optional operator-facing description. Absent (not empty-string) when
   * unset — the gateway trims on write and stores whitespace-only as absent.
   */
  description?: string | null;
  /**
   * For names that exist only as derived resource namespaces (no registry
   * row) these are observation timestamps stamped per-request, not stable
   * registry metadata — do not compare or cache them as identity.
   */
  created_at: string;
  updated_at: string;
}

export interface NamespaceCreate {
  name: string;
  description?: string | null;
}

export interface NamespaceUpdate {
  /** New name. Omit (not null) to keep the current name. */
  name?: string;
  /** `null` or empty string clears the description; omit to keep it. */
  description?: string | null;
}

// ── Client-side name validation (mirrors the OpenAPI schema) ─────

export const NAMESPACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const NAMESPACE_NAME_MAX_LENGTH = 254;
export const NAMESPACE_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Validate a namespace name against the gateway's schema
 * (`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, 1–254 chars). Returns a human-readable
 * error message, or `null` when the name is valid.
 */
export function validateNamespaceName(name: string): string | null {
  if (name.length === 0) return "Namespace name is required";
  if (name.length > NAMESPACE_NAME_MAX_LENGTH) {
    return `Namespace name must be at most ${NAMESPACE_NAME_MAX_LENGTH} characters`;
  }
  if (!NAMESPACE_NAME_PATTERN.test(name)) {
    return "Namespace name must start with a letter or digit and contain only letters, digits, dots, hyphens, and underscores";
  }
  return null;
}

/**
 * Build a minimal UpdateNamespaceRequest from the current record and the
 * edited values. Unchanged fields are omitted (the gateway treats omission
 * as "keep"); a cleared description is sent as `null`. `name: null` is never
 * produced — the gateway rejects it with 400. Returns `null` when nothing
 * changed.
 */
export function buildNamespaceUpdate(
  current: { name: string; description?: string | null },
  next: { name: string; description: string },
): NamespaceUpdate | null {
  const payload: NamespaceUpdate = {};

  const nextName = next.name.trim();
  if (nextName && nextName !== current.name) {
    payload.name = nextName;
  }

  const currentDescription = current.description ?? "";
  const nextDescription = next.description.trim();
  if (nextDescription !== currentDescription.trim()) {
    payload.description = nextDescription === "" ? null : nextDescription;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

// ── Occupancy ────────────────────────────────────────────────────

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

function topLevelCount(response: unknown): number | null {
  if (!response || typeof response !== "object" || !("total" in response)) return null;
  return validCount(response.total);
}

function paginatedCount(response: unknown): number | null {
  if (!response || typeof response !== "object" || !("pagination" in response)) return null;
  return topLevelCount(response.pagination);
}

/**
 * Resource kinds that keep a namespace "non-empty" for the purposes of
 * `DELETE /namespaces/{name}` — i.e. the rows a `?confirm=true` cascade
 * deletes. Ordered for display.
 */
const OCCUPANCY_ENDPOINTS = [
  { label: "proxies", path: "proxies", count: paginatedCount },
  { label: "consumers", path: "consumers", count: paginatedCount },
  { label: "plugin configs", path: "plugins/config", count: paginatedCount },
  { label: "upstreams", path: "upstreams", count: paginatedCount },
  { label: "API specs", path: "api-specs", count: topLevelCount },
  { label: "gateway trust bundles", path: "gateway-trust-bundles", count: paginatedCount },
] as const;

export interface OccupancyEntry {
  label: string;
  count: number;
}

export interface NamespaceOccupancy {
  entries: OccupancyEntry[];
  total: number;
  /**
   * True when at least one endpoint could not be counted (a mode-dependent
   * surface such as api-specs returning 404/503). The cascade may then remove
   * more than `total` reports, so the UI must not present it as exhaustive.
   */
  partial: boolean;
}

/**
 * Count the resources a cascade delete of `name` would destroy.
 *
 * Each list is fetched with `limit=1` — only the endpoint-specific total is
 * used, so this stays cheap regardless of namespace size. Requests are scoped to
 * `name` itself rather than the active namespace, since the delete target is
 * usually not the namespace being viewed.
 */
export async function getOccupancy(name: string): Promise<NamespaceOccupancy> {
  const target: NamespaceScope = { namespace: name };
  const results = await Promise.all(
    OCCUPANCY_ENDPOINTS.map(async (endpoint): Promise<OccupancyEntry | null> => {
      try {
        const response = await proxyApi
          .get(endpoint.path, scoped(target, { searchParams: { limit: "1" }, context: { [SILENT_ERRORS]: true } }))
          .json<unknown>();
        const count = endpoint.count(response);
        return count === null ? null : { label: endpoint.label, count };
      } catch {
        // Mode-dependent surfaces legitimately 404/503 on gateways without
        // the feature; treat them as uncountable rather than as zero.
        return null;
      }
    }),
  );

  const entries = results.filter((r): r is OccupancyEntry => r !== null);
  return {
    entries: entries.filter((e) => e.count > 0),
    total: entries.reduce((sum, e) => sum + e.count, 0),
    partial: results.some((r) => r === null),
  };
}


/**
 * Whether a failed delete is one a `?confirm=true` cascade could resolve.
 *
 * The gateway refuses a delete for two unrelated reasons: the namespace is
 * non-empty (cascade fixes it), or the namespace is protected — one this
 * gateway is configured to serve, or the last remaining registry row (cascade
 * cannot fix either, and offering it would just walk the user into a second
 * 409). The protected reason is documented as a fixed string naming the two
 * configuration keys, which is what we match on.
 */
export function isCascadableDeleteError(status: number, body: string): boolean {
  if (status !== 409) return false;
  return !/FERRUM_NAMESPACE|FERRUM_CP_NAMESPACES|last remaining/i.test(body);
}

// ── API functions ────────────────────────────────────────────────
//
// The registry itself is not tenant data, but the BFF still authorizes every
// gateway request against the caller's namespace grants, so registry calls
// carry the scope of the operation that made them like any other request.

export async function list(scope: NamespaceScope): Promise<string[]> {
  // GET /namespaces returns the standard { data, pagination } envelope of
  // plain namespace name strings. Older gateways returned a bare array.
  const first = await proxyApi
    .get(
      "namespaces",
      scoped(scope, {
        searchParams: { offset: "0", limit: String(ALL_PAGE_SIZE) },
      }),
    )
    .json<PaginatedResponse<string> | string[]>();
  if (Array.isArray(first)) return first;

  return collectAllPages(async (offset, limit) => {
    if (offset === 0 && limit === ALL_PAGE_SIZE) return first;
    const page = await proxyApi
      .get(
        "namespaces",
        scoped(scope, {
          searchParams: { offset: String(offset), limit: String(limit) },
        }),
      )
      .json<PaginatedResponse<string> | string[]>();
    if (Array.isArray(page)) {
      throw new Error("Gateway changed namespace pagination format mid-request");
    }
    return page;
  });
}

export async function get(
  scope: NamespaceScope,
  name: string,
): Promise<Namespace> {
  return proxyApi
    .get(`namespaces/${encodeURIComponent(name)}`, scoped(scope))
    .json<Namespace>();
}

export async function create(
  scope: NamespaceScope,
  data: NamespaceCreate,
): Promise<Namespace> {
  return proxyApi
    .post("namespaces", scoped(scope, { json: data }))
    .json<Namespace>();
}

export async function update(
  scope: NamespaceScope,
  name: string,
  data: NamespaceUpdate,
): Promise<Namespace> {
  return proxyApi
    .put(`namespaces/${encodeURIComponent(name)}`, scoped(scope, { json: data }))
    .json<Namespace>();
}

/**
 * Delete a namespace registry row. A non-empty namespace returns 409 unless
 * `confirm` is set, which cascade-deletes every resource in the namespace.
 */
export async function remove(
  scope: NamespaceScope,
  name: string,
  options: { confirm?: boolean } = {},
): Promise<void> {
  await proxyApi.delete(
    `namespaces/${encodeURIComponent(name)}`,
    scoped(scope, {
      searchParams: options.confirm ? { confirm: "true" } : {},
      // The unconfirmed call is a deliberate probe — a 409 is the gateway
      // telling us the namespace is non-empty, which the caller turns into a
      // cascade confirmation. Terminal failures are reported as a toast by
      // the caller, so the global popup would double up either way.
      context: { [SILENT_ERRORS]: true },
    }),
  );
}
