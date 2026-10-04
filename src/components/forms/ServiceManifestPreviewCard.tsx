import { useEffect, useId, useRef, useState } from 'react';
import { previewServiceManifest, type ServiceManifestPreview } from '@/api/serviceManifest';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useEditorIdentity, type EditorSession } from '@/hooks/useEditorIdentity';

export function ServiceManifestPreviewCard() {
  const session = useEditorIdentity('service-manifest-preview');
  return <ManifestPreview key={session.key} session={session} />;
}

function ManifestPreview({ session }: { session: EditorSession }) {
  const id = useId();
  const [document, setDocument] = useState('');
  const [preview, setPreview] = useState<ServiceManifestPreview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const submit = session.bind(async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    setPreview(null);
    setError('');
    try {
      const result = await previewServiceManifest(
        { namespace: session.identity.namespace }, document, controller.signal,
      );
      if (!controller.signal.aborted) {
        setPreview(result);
        setDocument('');
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Preview unavailable.');
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
      inFlight.current = null;
    }
  });

  return (
    <Card>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit().catch(() => setError('Namespace changed. Review a fresh manifest.'));
        }}
      >
        <p id={`${id}-help`} className="text-sm text-text-secondary">
          Paste the JSON data model of an Alloy service manifest for namespace{' '}
          <strong>{session.identity.namespace}</strong>. Viewers and editors can preview.
          Nothing is applied. TOML, URLs and file paths are not loaded.
        </p>
        <div>
          <label htmlFor={id} className="block text-sm text-text-primary mb-2">
            Service manifest JSON
          </label>
          <textarea
            id={id}
            aria-describedby={`${id}-help`}
            value={document}
            onChange={(event) => {
              setDocument(event.target.value);
              setPreview(null);
              setError('');
            }}
            disabled={pending}
            maxLength={32 * 1024}
            rows={10}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-bg-input p-3 font-mono text-sm text-text-primary"
          />
        </div>
        <div className="flex gap-3">
          <Button type="submit" loading={pending} disabled={!document.trim()}>
            Preview manifest
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setDocument('');
              setPreview(null);
              setError('');
            }}
          >
            Clear preview
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">{error}</p>
        )}
        {preview && (
          <section aria-label="Manifest preview" className="space-y-3">
            <p role="status" className="text-sm text-text-primary">
              Read-only desired configuration for {preview.summary.service} in{' '}
              {preview.summary.namespace}. No gateway changes were made.
            </p>
            <ul className="list-disc pl-5 text-sm text-text-secondary">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="text-sm text-text-secondary">
              Compare these fields in Proxies, Upstreams and Plugins before using their ordinary
              save flows. Auth and MCP declarations require separate policy review.
            </p>
            <pre
              aria-label="Desired configuration and summary"
              tabIndex={0}
              className="max-h-96 overflow-auto rounded-lg bg-bg-input p-3 text-xs text-text-primary"
            >
              {JSON.stringify({ summary: preview.summary, desired: preview.desired }, null, 2)}
            </pre>
          </section>
        )}
      </form>
    </Card>
  );
}
