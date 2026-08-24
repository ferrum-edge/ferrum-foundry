/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Namespace API functions                          */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type { PaginatedResponse } from "./types";

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

// ── API functions ────────────────────────────────────────────────

export async function list(): Promise<string[]> {
  // GET /namespaces returns the standard { data, pagination } envelope of
  // plain namespace name strings.
  const response = await proxyApi
    .get("namespaces", { searchParams: { limit: "1000" } })
    .json<PaginatedResponse<string> | string[]>();
  return Array.isArray(response) ? response : response.data;
}

export async function get(name: string): Promise<Namespace> {
  return proxyApi.get(`namespaces/${encodeURIComponent(name)}`).json<Namespace>();
}

export async function create(data: NamespaceCreate): Promise<Namespace> {
  return proxyApi.post("namespaces", { json: data }).json<Namespace>();
}

export async function update(
  name: string,
  data: NamespaceUpdate,
): Promise<Namespace> {
  return proxyApi
    .put(`namespaces/${encodeURIComponent(name)}`, { json: data })
    .json<Namespace>();
}

/**
 * Delete a namespace registry row. A non-empty namespace returns 409 unless
 * `confirm` is set, which cascade-deletes every resource in the namespace.
 */
export async function remove(
  name: string,
  options: { confirm?: boolean } = {},
): Promise<void> {
  await proxyApi.delete(`namespaces/${encodeURIComponent(name)}`, {
    searchParams: options.confirm ? { confirm: "true" } : {},
  });
}
