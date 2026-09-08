import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { resolveReadState, type ReadQuery } from '@/lib/readState';

/** For editors, render this notice beside the form, never around its draft. */
export function ReadStateNotice({
  query,
  label,
  optionalFeature = false,
}: {
  query: ReadQuery;
  label: string;
  optionalFeature?: boolean;
}) {
  const state = resolveReadState(query);
  if (state === 'loaded') return null;
  if (state === 'loading') return <SkeletonCard />;
  const status = (query.error as { response?: { status?: number } } | null)?.response?.status;
  const featureMiss =
    optionalFeature && state === 'unavailable' &&
    (status === 404 || status === 503);

  return (
    <Card className="border-warning/40" role="status">
      <p className="text-sm text-warning">
        {label} {state === 'stale' ? 'could not refresh' : 'unavailable'}
      </p>
      <p className="text-xs text-text-muted mt-1">
        Current state is unknown.
        {featureMiss && (
          <> This feature may not be enabled in this mode or is temporarily unavailable.</>
        )}
        {state === 'stale' && ' The last response is stale.'}
        {query.dataUpdatedAt > 0 && (
          <> Last successful observation: {new Date(query.dataUpdatedAt).toLocaleString()}.</>
        )}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3"
        loading={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Retry {label}
      </Button>
    </Card>
  );
}

/** Read-only conclusions and row actions require every input to have succeeded. */
export function ReadState({
  queries,
  label,
  children,
  optionalFeature = false,
}: {
  queries: ReadQuery[];
  label: string;
  children: ReactNode;
  optionalFeature?: boolean;
}) {
  if (queries.every((query) => resolveReadState(query) === 'loaded')) return children;
  return (
    <div className="space-y-3">
      {queries.map((query, index) => (
        <ReadStateNotice
          key={index}
          query={query}
          label={label}
          optionalFeature={optionalFeature}
        />
      ))}
    </div>
  );
}
