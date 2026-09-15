interface ResourceLabelsProps {
  labels?: Record<string, string>;
}

export function ResourceLabels({ labels }: ResourceLabelsProps) {
  const entries = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <section aria-label="Resource labels" className="rounded-lg border border-border p-4">
      <h2 className="mb-2 text-sm font-medium">Labels</h2>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="min-w-0 break-all">
            <dt className="text-text-muted">{key === "provisioned-by" ? "Provisioned by" : key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
