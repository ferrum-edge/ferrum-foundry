import type { PaginatedResponse } from "./types";

export const ALL_PAGE_SIZE = 250;

/**
 * How many records an ordinary list view will traverse before it stops and
 * says so.
 *
 * `GET /proxies`, `GET /upstreams`, and `GET /plugins/config` accept only
 * `offset` and `limit` — the admin API has no search, filter, or reference
 * query (see `docs/data-loading.md`). A view that needs a derived number over
 * a whole collection therefore has no bounded contract to ask for it, and the
 * only honest options are "traverse it" or "say you did not". This budget
 * picks the point where a summary column switches from the first to the
 * second. It is not a cap on correctness-critical reads: a view whose answer
 * is an authorization conclusion traverses the collection completely or
 * reports unknown, never a partial graph.
 */
export const SUMMARY_SCAN_BUDGET = 2_000;

export interface CollectOptions {
  pageSize?: number;
  /**
   * Stop after this many records. The result is then reported as incomplete
   * rather than returned as if it were the whole collection.
   */
  budget?: number;
  /** Abort in-flight and pending pages; the returned promise rejects. */
  signal?: AbortSignal;
}

export interface BoundedCollection<T> {
  readonly items: T[];
  /** The collection size the gateway reported. */
  readonly total: number;
  /** True only when `items` is the entire collection. */
  readonly complete: boolean;
}

type PageFetcher<T> = (
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => Promise<PaginatedResponse<T>>;

/**
 * Walk a collection page by page, stopping at `budget` records.
 *
 * Pages are fetched sequentially and each offset is derived from the number of
 * records the previous page actually returned. That is deliberate and is why
 * this is not parallelised: computing offsets ahead of time would assume every
 * page except the last returns exactly `limit` records, and a gateway that
 * returned a short page would silently drop or duplicate records. The existing
 * fail-closed consistency checks — non-advancing pages, a shifting total, an
 * over-long response — are kept for the same reason.
 *
 * A concurrent insert or delete that changes the observed total still aborts
 * the traversal. That is a bounded, explicit failure the caller renders as a
 * read error; it is not a silent truncation and it is not an endless restart.
 */
export async function collectBoundedPages<T>(
  fetchPage: PageFetcher<T>,
  options: CollectOptions = {},
): Promise<BoundedCollection<T>> {
  const pageSize = options.pageSize ?? ALL_PAGE_SIZE;
  const budget = options.budget ?? Number.POSITIVE_INFINITY;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive safe integer");
  }
  if (budget !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(budget) || budget < 1)) {
    throw new Error("budget must be a positive safe integer");
  }

  const items: T[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;

  for (;;) {
    options.signal?.throwIfAborted();
    const page = await fetchPage(offset, pageSize, options.signal);
    const { pagination } = page;

    if (
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      !Number.isSafeInteger(pagination.offset) ||
      pagination.offset !== offset
    ) {
      throw new Error("Gateway returned inconsistent pagination metadata");
    }

    if (expectedTotal === undefined) {
      expectedTotal = pagination.total;
    } else if (pagination.total !== expectedTotal) {
      throw new Error("Gateway changed pagination total while collecting pages");
    }
    items.push(...page.data);

    if (items.length >= expectedTotal) {
      if (items.length !== expectedTotal) {
        throw new Error("Gateway returned more resources than its pagination total");
      }
      return { items, total: expectedTotal, complete: true };
    }

    if (items.length >= budget) {
      return { items, total: expectedTotal, complete: false };
    }

    if (page.data.length === 0) {
      throw new Error("Gateway pagination stopped advancing before completion");
    }

    offset += page.data.length;
  }
}

/**
 * Fetch a collection to completion.
 *
 * Reserved for operations whose answer is wrong if it is partial — an
 * effective-policy graph, a membership set, an export. Ordinary list and
 * detail navigation should use `collectBoundedPages` with a budget and render
 * an explicit incomplete state instead.
 */
export async function collectAllPages<T>(
  fetchPage: PageFetcher<T>,
  pageSize = ALL_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<T[]> {
  const collected = await collectBoundedPages(fetchPage, { pageSize, signal });
  return collected.items;
}
