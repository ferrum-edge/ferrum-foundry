import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime, humanizeKey, isIsoTimestamp } from '@/lib/format';

export type HealthTone = 'red' | 'yellow' | 'green' | 'default';
export type HealthField = readonly [string, string | number | boolean | null | undefined];

function displayValue(value: HealthField[1]) {
  if (value == null) return 'Not reported';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // Timestamps arrive as ISO strings; show them like every other date.
  if (isIsoTimestamp(value)) return formatDateTime(value);
  return value;
}

/**
 * Pairs of fields go two across only when the card itself is wide (a
 * container query, not the viewport), so half-width cards on a two-column
 * page never squeeze values into broken fragments.
 */
export function HealthFields({ fields }: { fields: readonly HealthField[] }) {
  return <div className="@container">
    <dl className="grid grid-cols-1 @xl:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {fields.map(([label, value]) => <div key={label} className="flex justify-between gap-3">
        <dt className="text-text-secondary">{label}</dt>
        <dd className="min-w-0 text-text-primary text-right [overflow-wrap:anywhere] tabular-nums">{displayValue(value)}</dd>
      </div>)}
    </dl>
  </div>;
}

const UNIX_MS_SUFFIX = '_unix_ms';

/**
 * Explicit scalar fields only; nested contracts get their own UI, never a JSON
 * flattener. Keys become sentence-case labels, and a `*_unix_ms` epoch is
 * shown as a date under the label without its unit suffix.
 */
export function namedFields<T extends object>(data: T, keys: readonly (keyof T)[]): HealthField[] {
  return keys.map((key) => {
    const name = String(key);
    const value = data[key];
    if (name.endsWith(UNIX_MS_SUFFIX) && typeof value === 'number') {
      return [humanizeKey(name.slice(0, -UNIX_MS_SUFFIX.length)), formatDateTime(value)];
    }
    return [humanizeKey(name),
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined];
  });
}

export function HealthSection({ title, tone = 'default', status, children }: {
  title: string; tone?: HealthTone; status?: string; children: ReactNode;
}) {
  return <Card role="region" aria-label={title}
    className={tone === 'red' ? 'border-danger/40' : tone === 'yellow' ? 'border-warning/40' : ''}>
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {status && <Badge variant={tone}>{status}</Badge>}
    </div>
    <div className="space-y-3">{children}</div>
  </Card>;
}

export function CounterNote({ scope = 'process' }: { scope?: string }) {
  return <p className="text-xs text-text-muted">Cumulative counters describe this {scope}’s history, not a current failure rate. A recovered sink can still have recorded loss.</p>;
}
