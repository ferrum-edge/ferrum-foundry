/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Pagination hook with URL search-param sync       */
/* ------------------------------------------------------------------ */

import { useCallback, useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { PaginationParams } from "@/api/types";

const DEFAULT_LIMIT = 20;

interface UsePaginationOptions {
  /** Default page size (defaults to 20). */
  defaultLimit?: number;
}

interface UsePaginationReturn {
  offset: number;
  limit: number;
  total: number;
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
  setLimit: (limit: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  /** Ready-made params object for API calls. */
  paginationParams: PaginationParams;
  /** Call this when an API response arrives to record total count. */
  setTotal: (total: number) => void;
}

export function usePagination(
  total: number,
  opts: UsePaginationOptions = {},
): UsePaginationReturn {
  const defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;

  // Read offset / limit from the URL search params (via TanStack Router)
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  const offset = Number(search.offset ?? 0);
  const limit = Number(search.limit ?? defaultLimit);

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const updateSearch = useCallback(
    (patch: Record<string, number>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({
        search: (prev: any) => ({ ...prev, ...patch }),
        replace: true,
      } as any);
    },
    [navigate],
  );

  const setPage = useCallback(
    (p: number) => {
      const clamped = Math.max(1, Math.min(p, totalPages));
      updateSearch({ offset: (clamped - 1) * limit });
    },
    [limit, totalPages, updateSearch],
  );

  const setLimit = useCallback(
    (newLimit: number) => {
      updateSearch({ offset: 0, limit: newLimit });
    },
    [updateSearch],
  );

  const nextPage = useCallback(() => setPage(page + 1), [page, setPage]);
  const prevPage = useCallback(() => setPage(page - 1), [page, setPage]);

  const paginationParams = useMemo<PaginationParams>(
    () => ({ offset, limit }),
    [offset, limit],
  );

  // setTotal is a no-op here since total is passed in from the query result,
  // but kept in the return type for convenience.
  const setTotal = useCallback((_t: number) => {}, []);

  return {
    offset,
    limit,
    total,
    page,
    totalPages,
    setPage,
    setLimit,
    nextPage,
    prevPage,
    paginationParams,
    setTotal,
  };
}
