/** A retained response is evidence of a past read, not a successful current read. */
export interface ReadQuery {
  data: unknown;
  isError: boolean;
  isLoading: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  error: unknown;
  refetch: () => Promise<unknown>;
}

export function resolveReadState(query: Pick<ReadQuery, 'data' | 'isError' | 'isLoading'>) {
  if (query.isError) return query.data === undefined ? 'unavailable' : 'stale';
  if (query.isLoading || query.data === undefined) return 'loading';
  return 'loaded';
}
