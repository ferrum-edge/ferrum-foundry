import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  proxyPathIsConsumerVerification,
  proxyPathIsDeploymentSnapshot,
  proxyPathIsAllowedForNamespace,
  proxyPathIsEdgeNamespaceSafeGlobal,
  proxyTargetPath,
  proxyTargetUrl,
  servesSpaShell,
  UnsafeProxyPathError,
} from './proxy-path.js';

function request(url: string, wildcard?: string, method = 'GET'): FastifyRequest {
  return {
    raw: { url }, url, method,
    params: wildcard === undefined ? {} : { '*': wildcard },
    routeOptions: { url: wildcard === undefined ? url.split('?')[0] : '/api/proxy/*' },
  } as FastifyRequest;
}

describe('canonical proxy targets', () => {
  it.each([
    ['GET', '/api/proxy/proxies'],
    ['POST', '/api/proxy/upstreams'],
    ['GET', '/api/proxy/consumers/alice'],
    ['POST', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['PUT', '/api/proxy/plugins/config/config-1'],
    ['GET', '/api/proxy/api-specs/by-proxy/orders'],
    ['GET', '/api/proxy/proxies/agents/mcp/tools'],
    ['GET', '/api/proxy/gateway-trust-bundles'],
    ['GET', '/api/proxy/config/export'],
    ['GET', '/api/proxy/audit'],
    ['GET', '/api/proxy/backend-egress-policy'],
    ['POST', '/api/proxy/batch'],
    ['GET', '/api/proxy/backup'],
  ])('allows known namespace-scoped route class %s %s', (method, url) => {
    expect(proxyPathIsAllowedForNamespace(request(url, undefined, method))).toBe(true);
  });

  it.each([
    ['PUT', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['POST', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth/'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth/0/'],
  ])('allows the credential method Edge serves %s %s', (method, url) => {
    expect(proxyPathIsAllowedForNamespace(request(url, undefined, method))).toBe(true);
  });

  it.each([
    // An indexed credential is only ever deleted.
    ['GET', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['HEAD', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['PUT', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['POST', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['PATCH', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    ['OPTIONS', '/api/proxy/consumers/alice/credentials/keyauth/0'],
    // A credential type is replaced, appended to, or cleared; never read.
    ['GET', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['HEAD', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['PATCH', '/api/proxy/consumers/alice/credentials/keyauth'],
    ['OPTIONS', '/api/proxy/consumers/alice/credentials/keyauth'],
    // Neither the credential collection nor a deeper path is a route.
    ['GET', '/api/proxy/consumers/alice/credentials'],
    ['DELETE', '/api/proxy/consumers/alice/credentials'],
    ['DELETE', '/api/proxy/consumers/alice/credentials/keyauth/0/extra'],
  ])('denies the credential method Edge does not serve %s %s', (method, url) => {
    expect(proxyPathIsAllowedForNamespace(request(url, undefined, method))).toBe(false);
  });

  it.each([
    ['GET', '/api/proxy/plugins'],
    ['GET', '/api/proxy/namespaces'],
    ['GET', '/api/proxy/namespaces/tenant-a'],
    ['GET', '/api/proxy/live'],
    ['GET', '/api/proxy/health'],
    ['GET', '/api/proxy/status'],
    ['HEAD', '/api/proxy/health'],
    ['POST', '/api/proxy/namespaces'],
    ['PUT', '/api/proxy/namespaces/tenant-a'],
    ['DELETE', '/api/proxy/namespaces/tenant-a'],
  ])('allows Edge namespace-safe global route class %s %s', (method, url) => {
    const req = request(url, undefined, method);
    expect(proxyPathIsEdgeNamespaceSafeGlobal(req)).toBe(true);
    expect(proxyPathIsAllowedForNamespace(req)).toBe(true);
  });

  // Ferrum Edge v0.9.16+ refuses every one of these to an admin JWT carrying
  // an `ns` claim (`ns_claim_global_route_is_allowed`, ferrum-edge#6093), so
  // the BFF refuses them to a scoped principal whatever the gateway version.
  it.each([
    ['GET', '/api/proxy/charges'],
    ['GET', '/api/proxy/charges/sink/status'],
    ['GET', '/api/proxy/metrics'],
    ['GET', '/api/proxy/admin/metrics'],
    ['GET', '/api/proxy/metrics/runtime'],
    ['GET', '/api/proxy/cluster'],
    ['GET', '/api/proxy/config/apply-status'],
    ['HEAD', '/api/proxy/config/apply-status'],
    ['GET', '/api/proxy/backend-capabilities'],
    ['POST', '/api/proxy/backend-capabilities/refresh'],
    ['GET', '/api/proxy/mesh/service-graph'],
    ['GET', '/api/proxy/mesh/federation'],
    ['GET', '/api/proxy/mesh/egress-scope'],
    ['POST', '/api/proxy/mesh/egress-scope/test'],
    ['GET', '/api/proxy/node-waypoint/identities'],
    ['GET', '/api/proxy/service-waypoint/services'],
    ['GET', '/api/proxy/mesh/runtime-overlay'],
    ['POST', '/api/proxy/mesh/config-revision/reset'],
    ['GET', '/api/proxy/overload'],
    ['HEAD', '/api/proxy/overload'],
    ['GET', '/api/proxy/health/'],
    ['GET', '/api/proxy/backend-egress-policy/'],
    ['GET', '/api/proxy/diagnostics/v1/refs/fd1_00'],
    ['POST', '/api/proxy/plugins'],
    ['OPTIONS', '/api/proxy/proxies'],
    ['GET', '/api/proxy/a-new-admin-route'],
  ])('denies fleet-wide and unclassified route classes %s %s', (method, url) => {
    const req = request(url, undefined, method);
    expect(proxyPathIsAllowedForNamespace(req)).toBe(false);
    expect(proxyPathIsEdgeNamespaceSafeGlobal(req)).toBe(false);
  });

  it.each([
    ['GET', '/api/proxy/admin/tls/inventory'],
    ['GET', '/api/proxy/admin/tls/events'],
    ['GET', '/api/proxy/admin/tls/certificates'],
    ['GET', '/api/proxy/admin/tls/certificates/cert-1'],
    ['HEAD', '/api/proxy/admin/tls/certificates/cert-1'],
    ['GET', '/api/proxy/admin/tls/acme/accounts'],
    ['GET', '/api/proxy/admin/tls/acme/orders/order-1'],
    ['POST', '/api/proxy/admin/tls/validate'],
    ['POST', '/api/proxy/admin/tls/rotate/all'],
    ['DELETE', '/api/proxy/admin/tls/certificates/cert-1'],
    ['DELETE', '/api/proxy/admin/tls/acme/orders/order-1'],
    ['POST', '/api/proxy/admin/tls/certificates'],
    ['PUT', '/api/proxy/admin/tls/certificates/cert-1'],
    ['PUT', '/api/proxy/admin/tls/ca-bundles/bundle-1'],
    ['POST', '/api/proxy/admin/tls/jwks'],
    ['PUT', '/api/proxy/admin/tls/ocsp-responses/ocsp-1'],
    ['POST', '/api/proxy/admin/tls/acme/orders'],
    ['POST', '/api/proxy/admin/tls/acme/orders/order-1/finalize'],
    ['POST', '/api/proxy/admin/tls/acme/renew/cert-1'],
    ['PUT', '/api/proxy/admin/tls/acme/certificates/cert-1'],
  ])('denies every fleet TLS route %s %s to scoped principals, reads and validation included', (method, url) => {
    const req = request(url, undefined, method);
    expect(proxyPathIsAllowedForNamespace(req)).toBe(false);
    expect(proxyPathIsEdgeNamespaceSafeGlobal(req)).toBe(false);
  });

  it('classifies HEAD like GET on namespace-scoped routes', () => {
    expect(proxyPathIsAllowedForNamespace(request('/api/proxy/proxies/p1', undefined, 'HEAD'))).toBe(true);
    expect(proxyPathIsAllowedForNamespace(request('/api/proxy/backup', undefined, 'HEAD'))).toBe(true);
    expect(proxyPathIsEdgeNamespaceSafeGlobal(request('/api/proxy/proxies', undefined, 'HEAD'))).toBe(false);
  });

  const unsafe = [
    '.', '..', '%2e', '.%2e', '%2e.', '%2E%2e',
    '..%09', '..%0a', '..%0d', '.%09.', '%00', '%1f', '%7f',
    '%2f', '%2Fproxies', '%5c', '\\', '..%5cproxies',
    '%', '%2', '%gg', '%c0%af', '%ed%a0%80',
    '%252e%252e', '%2509', '%252f', '%255c', '%25252525252525252e',
  ];

  it.each(unsafe)('rejects ambiguous segment %s with either route shape', (segment) => {
    const url = `/api/proxy/admin/tls/${segment}/proxies`;
    // Params can already contain decoded controls/separators. They must not
    // become the input to a second, different policy/URL interpretation.
    let wildcard = segment;
    try { wildcard = decodeURIComponent(segment); } catch { /* malformed wire input */ }
    for (const params of [undefined, `admin/tls/${wildcard}/proxies`]) {
      const req = request(url, params);
      expect(() => proxyTargetPath(req)).toThrow(UnsafeProxyPathError);
      expect(proxyPathIsAllowedForNamespace(req)).toBe(false);
    }
  });

  it('rejects every raw and encoded C0 control and DEL before serialization', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      for (const segment of [String.fromCharCode(code), `%${code.toString(16).padStart(2, '0')}`]) {
        expect(() => proxyTargetPath(request(`/api/proxy/a/..${segment}/b`))).toThrow(UnsafeProxyPathError);
      }
    }
  });

  it.each(['//proxies', '/admin//tls/inventory', '/proxies#other', '/proxies/%25id'])('rejects ambiguous path %s', (path) => {
    expect(() => proxyTargetPath(request(`/api/proxy${path}`))).toThrow(UnsafeProxyPathError);
  });

  it.each([
    ['/api/proxy/proxies', '/proxies'],
    ['/%61pi/pr%6fxy/%61pi-specs', '/api-specs'],
    ['/api/proxy/proxies/a.b', '/proxies/a.b'],
    ['/api/proxy/proxies/a%20b', '/proxies/a%20b'],
    ['/api/proxy/proxies/caf%C3%A9', '/proxies/caf%C3%A9'],
    ['/api/proxy/proxies/a%3Fb%23c', '/proxies/a%3Fb%23c'],
    ['/api/proxy/proxies/a%3Ab%40c', '/proxies/a:b@c'],
    ['/api/proxy/', '/'],
    ['/api/proxy/proxies/', '/proxies/'],
  ])('serializes %s once as %s', (url, expected) => {
    for (const wildcard of [undefined, 'ignored-router-decoding']) {
      const req = request(url, wildcard);
      expect(proxyTargetPath(req)).toBe(expected);
      expect(proxyTargetUrl(req, 'https://gateway.test/base?old=1#old').href).toBe(`https://gateway.test${expected}`);
    }
  });

  it.each([
    ['/api/proxy/consumers/id/verification', true],
    ['/api/proxy/%63onsumers/a%3Fb%23c/%76erification/?query=1', true],
    ['/api/proxy/consumers/caf%C3%A9/verification', true],
    ['/api/proxy/consumers/id', false],
    ['/api/proxy/consumers/verification', false],
    ['/api/proxy/consumers/id?path=/verification', false],
    ['/api/proxy/consumers/id/verification/extra', false],
  ])('classifies only the exact forwarded canonical pathname of %s', (url, denied) => {
    const req = request(url, 'router-params-are-not-policy');
    const target = proxyTargetUrl(req, 'https://gateway.test');
    expect(proxyPathIsConsumerVerification(proxyTargetPath(req))).toBe(denied);
    expect(proxyPathIsConsumerVerification(target.pathname)).toBe(denied);
  });

  it.each([
    ['/api/proxy/deployment-snapshot', true],
    ['/api/proxy/deployment-snapshot/', true],
    ['/api/proxy/deployment-snapshot?resources=consumers', true],
    ['/api/proxy/%64eployment-%73napshot/?query=%zz', true],
    ['/%61pi/pr%6fxy/deploym%65nt-snapshot', true],
    ['/api/proxy/deployment-snapshot/extra', false],
    ['/api/proxy/deployment-snapshots', false],
    ['/api/proxy/admin/deployment-snapshot', false],
    ['/api/proxy/proxies/deployment-snapshot', false],
    ['/api/proxy/consumers/deployment-snapshot', false],
    ['/api/proxy/backup?path=/deployment-snapshot', false],
    ['/api/proxy/config/export?path=%2Fdeployment-snapshot', false],
  ])('classifies only the exact deployment snapshot pathname of %s', (url, denied) => {
    for (const wildcard of [undefined, 'router-params-are-not-policy']) {
      const req = request(url, wildcard);
      const target = proxyTargetUrl(req, 'https://gateway.test');
      expect(proxyPathIsDeploymentSnapshot(proxyTargetPath(req))).toBe(denied);
      expect(proxyPathIsDeploymentSnapshot(target.pathname)).toBe(denied);
    }
  });

  it('keeps query syntax and escapes separate from path validation', () => {
    const query = '?cursor=a%2Fb%2525&tag=a+b&tag=%20&value=..%09&malformed=%zz&empty=';
    const req = request(`/api/proxy/proxies/a%3Fb${query}`);
    const target = proxyTargetUrl(req, 'http://gateway.test');
    expect(target.pathname).toBe('/proxies/a%3Fb');
    expect(target.search).toBe(query);
  });

  it('keeps every accepted generated path stable through URL serialization', () => {
    const atoms = ['a', '.', '..', '%', '%25', '%2e', '%2f', '%5c', '%09', '%0a', '%0d', '%7f', '%20', '%3f', '%23', '%C3%A9', '@', ':', '+'];
    let accepted = 0;
    for (const a of atoms) for (const b of atoms) {
      const req = request(`/api/proxy/resources/${a}${b}`);
      let path: string;
      try { path = proxyTargetPath(req); } catch (error) {
        expect(error).toBeInstanceOf(UnsafeProxyPathError);
        continue;
      }
      accepted += 1;
      for (const base of ['http://gateway.test', 'https://gateway.test']) {
        expect(new URL(base + path).pathname).toBe(path);
        expect(proxyTargetUrl(req, base).pathname).toBe(path);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});

describe('SPA shell fallback', () => {
  it.each([
    ['GET', '/proxies/orders.v2'],
    ['GET', '/settings?tab=namespaces'],
    ['HEAD', '/'],
  ])('serves the shell for a page navigation: %s %s', (method, url) => {
    expect(servesSpaShell(request(url, undefined, method))).toBe(true);
  });

  it.each([
    ['GET', '/assets/index-OLDHASH1.js'],
    ['GET', '/api'],
    ['GET', '/api/unknown'],
    ['POST', '/settings'],
    ['DELETE', '/proxies/orders'],
  ])('answers 404 instead of the shell: %s %s', (method, url) => {
    expect(servesSpaShell(request(url, undefined, method))).toBe(false);
  });
});
