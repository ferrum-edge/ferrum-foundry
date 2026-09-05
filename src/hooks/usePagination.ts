/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – sanitized URL-backed pagination                  */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { PaginationParams } from "@/api/types";

export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_OFFSET = 10_000_000;

interface UsePaginationOptions {
  defaultLimit?: number;
}

export interface SanitizedPagination {
  offset: number;
  limit: number;
  changed: boolean;
}

function exactInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function sanitizePaginationSearch(
  search: Readonly<Record<string, unknown>>,
  defaultLimit = DEFAULT_PAGE_SIZE,
): SanitizedPagination {
  const safeDefault = PAGE_SIZE_OPTIONS.includes(
    defaultLimit as (typeof PAGE_SIZE_OPTIONS)[number],
  )
    ? defaultLimit
    : DEFAULT_PAGE_SIZE;
  const rawOffset = exactInteger(search.offset);
  const rawLimit = exactInteger(search.limit);
  const offset = rawOffset !== undefined && rawOffset <= MAX_OFFSET ? rawOffset : 0;
  const limit = rawLimit !== undefined && PAGE_SIZE_OPTIONS.includes(
    rawLimit as (typeof PAGE_SIZE_OPTIONS)[number],
  )
    ? rawLimit
    : safeDefault;

  return {
    offset,
    limit,
    changed:
      (search.offset !== undefined && (rawOffset === undefined || rawOffset !== offset)) ||
      (search.limit !== undefined && (rawLimit === undefined || rawLimit !== limit)),
  };
}

export function usePaginationParams(opts: UsePaginationOptions = {}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const sanitized = sanitizePaginationSearch(search, opts.defaultLimit);

  const setParams = useCallback(
    ({ offset, limit }: PaginationParams) => {
      const next = sanitizePaginationSearch({ offset, limit }, opts.defaultLimit);
      navigate({
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          offset: next.offset,
          limit: next.limit,
        }),
        replace: true,
      } as never);
    },
    [navigate, opts.defaultLimit],
  );

  useEffect(() => {
    if (!sanitized.changed) return;
    setParams({ offset: sanitized.offset, limit: sanitized.limit });
  }, [sanitized.changed, sanitized.offset, sanitized.limit, setParams]);

  const paginationParams = useMemo<PaginationParams>(
    () => ({ offset: sanitized.offset, limit: sanitized.limit }),
    [sanitized.offset, sanitized.limit],
  );

  return {
    offset: sanitized.offset,
    limit: sanitized.limit,
    paginationParams,
    setParams,
  };
}

export function usePagination(total: number, opts: UsePaginationOptions = {}) {
  const pagination = usePaginationParams(opts);
  const page = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
  const setPage = useCallback(
    (requested: number) => {
      const clamped = Math.max(1, Math.min(requested, totalPages));
      pagination.setParams({
        offset: (clamped - 1) * pagination.limit,
        limit: pagination.limit,
      });
    },
    [pagination.limit, pagination.setParams, totalPages],
  );
  const setLimit = useCallback(
    (limit: number) => pagination.setParams({ offset: 0, limit }),
    [pagination.setParams],
  );

  return {
    ...pagination,
    total,
    page,
    totalPages,
    setPage,
    setLimit,
    nextPage: () => setPage(page + 1),
    prevPage: () => setPage(page - 1),
    setTotal: (_total: number) => undefined,
  };
}
