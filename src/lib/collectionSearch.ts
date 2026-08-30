export interface FilteredPage<T> {
  items: T[];
  total: number;
}

/** Filter a complete collection before taking the requested UI page. */
export function filterAndPage<T>(
  items: readonly T[],
  query: string,
  matches: (item: T, normalizedQuery: string) => boolean,
  offset: number,
  limit: number,
): FilteredPage<T> {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? items.filter((item) => matches(item, normalized))
    : [...items];
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}
