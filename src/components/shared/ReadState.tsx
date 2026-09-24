import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { resolveReadState, type ReadQuery } from '@/lib/readState';

export function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/**
 * True when the gateway (or the BFF) refused the read itself with `403`.
 *
 * A denial is an answer about the session, not about the data: it must never
 * be rendered as an empty collection or as a feature this gateway lacks. Only
 * `404`/`503` on an optional surface mean "not enabled here".
 */
export function isReadDenied(error: unknown): boolean {
  return errorStatus(error) === 403;
}

/** The notice for a read the session is not permitted to make. */
export function ReadDeniedNotice({ label }: { label: string }) {
  return (
    <Card className="border-warning/40" role="status" data-read-denied="">
      <p className="text-sm text-warning">{label}: read not permitted for this session</p>
      <p className="text-xs text-text-muted mt-1">
        The gateway refused this read for your session&apos;s role or namespace grant. This is an
        authorization denial, not missing or empty data.
      </p>
    </Card>
  );
}

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
  if (state === 'unavailable' && isReadDenied(query.error)) {
    return <ReadDeniedNotice label={label} />;
  }
  const status = errorStatus(query.error);
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
