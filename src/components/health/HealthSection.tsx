import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

export type HealthTone = 'red' | 'yellow' | 'green' | 'default';
export type HealthField = readonly [string, string | number | boolean | null | undefined];

export function HealthFields({ fields }: { fields: readonly HealthField[] }) {
  return <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
    {fields.map(([label, value]) => <div key={label} className="flex justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-text-primary text-right break-all">
        {value == null ? 'Not reported' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}
      </dd>
    </div>)}
  </dl>;
}

/** Explicit scalar fields only; nested contracts get their own UI, never a JSON flattener. */
export function namedFields<T extends object>(data: T, keys: readonly (keyof T)[]): HealthField[] {
  return keys.map((key) => {
    const value = data[key];
    return [String(key).replaceAll('_', ' '),
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
