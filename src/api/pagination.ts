import type { PaginatedResponse } from "./types";

export const ALL_PAGE_SIZE = 250;

/**
 * Fetch a collection to completion without relying on an arbitrarily large
 * page size. A non-advancing or internally inconsistent gateway response is
 * rejected instead of being mistaken for a complete relationship graph.
 */
export async function collectAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<PaginatedResponse<T>>,
  pageSize = ALL_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive safe integer");
  }

  const items: T[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;

  for (;;) {
    const page = await fetchPage(offset, pageSize);
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
      return items;
    }

    if (page.data.length === 0) {
      throw new Error("Gateway pagination stopped advancing before completion");
    }

    offset += page.data.length;
  }
}
