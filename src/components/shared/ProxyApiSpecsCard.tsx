import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useApiSpecsByProxy, useApiSpecDocumentByProxy } from '@/hooks/useApiSpecs';
import { useCapabilities } from '@/stores/capabilities';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ReadState } from './ReadState';

export function ProxyApiSpecsCard({ proxyId, enabled = true }: { proxyId: string; enabled?: boolean }) {
  const [view, setView] = useState(false);
  const query = useApiSpecsByProxy(proxyId, enabled);
  const { facts } = useCapabilities();
  // Summary metadata is readable by all roles; raw stored documents require admin.
  const canReadDocument = facts.role === null || facts.role === 'admin';
  const documentQuery = useApiSpecDocumentByProxy(proxyId, enabled && view && canReadDocument);
  return <Card role="region" aria-label="Bound API specs">
    <h2 className="text-sm font-semibold text-text-primary mb-3">Bound API specs</h2>
    {!enabled ? <p className="text-sm text-text-muted">Refresh the proxy before inspecting its bindings.</p> : <ReadState queries={[query]} label="API spec bindings" optionalFeature>
      {query.data?.length === 0 && <p className="text-sm text-text-muted">No API spec is bound to this proxy in this namespace.</p>}
      {query.data?.map(spec => <div key={spec.id} className="space-y-3">
        <Link to="/api-specs" search={{ spec: spec.id } as never}
          className="text-orange hover:text-orange-light font-medium break-all">
          {spec.title || spec.id}
        </Link>
        <p className="text-xs text-text-muted break-all">Spec {spec.id} · OpenAPI {spec.spec_version} · {spec.operation_count} operations</p>
        <p className="text-xs text-text-muted">This is the stored binding, not a comparison with live routes.</p>
        {canReadDocument ? <Button variant="secondary" size="sm" onClick={() => setView(!view)}>
          {view ? 'Hide bound document' : 'View bound document'}
        </Button> : <p className="text-sm text-text-muted">The admin role is required to read the original spec document.</p>}
        {view && canReadDocument && <ReadState queries={[documentQuery]} label="Bound spec document">
          {documentQuery.data === null ? <p className="text-warning text-sm">No spec is now bound to this proxy. The binding may have been removed since the list was read.</p> :
            <pre className="text-xs font-mono text-text-secondary bg-code-bg rounded-lg p-3 overflow-auto max-h-96">{documentQuery.data}</pre>}
        </ReadState>}
      </div>)}
    </ReadState>}
  </Card>;
}
