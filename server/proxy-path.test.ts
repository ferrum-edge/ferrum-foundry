import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  proxyPathIsConsumerVerification,
  proxyPathIsDeploymentSnapshot,
  proxyPathIsAllowedForNamespace,
  proxyPathIsEdgeNamespaceSafeGlobal,
  proxyPathIsFleetGlobal,
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
    ['PUT', '/api/proxy/plugins/config/config-1'],
    ['GET', '/api/proxy/api-specs/by-proxy/orders'],
    ['GET', '/api/proxy/gateway-trust-bundles'],
    ['GET', '/api/proxy/mesh/egress-scope'],
    ['POST', '/api/proxy/mesh/egress-scope/test'],
    ['POST', '/api/proxy/batch'],
    ['GET', '/api/proxy/backup'],
  ])('allows known namespace-scoped route class %s %s', (method, url) => {
    expect(proxyPathIsAllowedForNamespace(request(url, undefined, method))).toBe(true);
  });

  it.each([
    ['GET', '/api/proxy/plugins'],
    ['GET', '/api/proxy/namespaces'],
    ['GET', '/api/proxy/namespaces/tenant-a'],
    ['GET', '/api/proxy/health'],
    ['GET', '/api/proxy/live'],
    ['GET', '/api/proxy/status'],
    ['GET', '/api/proxy/overload'],
  ])('allows Edge namespace-safe global route class %s %s', (method, url) => {
    const req = request(url, undefined, method);
    expect(proxyPathIsEdgeNamespaceSafeGlobal(req)).toBe(true);
    expect(proxyPathIsAllowedForNamespace(req)).toBe(true);
  });

  it.each([
    ['GET', '/api/proxy/charges'],
    ['GET', '/api/proxy/admin/metrics'],
    ['GET', '/api/proxy/metrics/runtime'],
    ['GET', '/api/proxy/cluster'],
    ['GET', '/api/proxy/mesh/service-graph'],
    ['GET', '/api/proxy/mesh/federation'],
    ['GET', '/api/proxy/node-waypoint/identities'],
    ['GET', '/api/proxy/mesh/runtime-overlay'],
    ['POST', '/api/proxy/mesh/config-revision/reset'],
    ['POST', '/api/proxy/backend-capabilities/refresh'],
    ['GET', '/api/proxy/a-new-admin-route'],
  ])('denies fleet-wide and unclassified route classes %s %s', (method, url) => {
    expect(proxyPathIsAllowedForNamespace(request(url, undefined, method))).toBe(false);
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
      expect(proxyPathIsFleetGlobal(req)).toBe(false);
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

  it('limits namespace-free access to known TLS operations', () => {
    for (const collection of ['certificates', 'ca-bundles', 'crls', 'ocsp-responses', 'jwks', 'acme/certificates']) {
      for (const method of ['GET', 'POST']) {
        expect(proxyPathIsFleetGlobal(request(`/api/proxy/admin/tls/${collection}`, undefined, method))).toBe(true);
      }
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect(proxyPathIsFleetGlobal(request(`/api/proxy/admin/tls/${collection}/id`, undefined, method))).toBe(true);
      }
    }
    for (const [method, path] of [
      ['GET', 'inventory'], ['GET', 'events'], ['GET', 'acme/accounts'],
      ['GET', 'acme/orders'], ['POST', 'acme/orders'], ['GET', 'acme/orders/id'],
      ['DELETE', 'acme/orders/id'], ['POST', 'acme/orders/id/finalize'],
      ['POST', 'acme/renew/id'], ['POST', 'rotate/all'], ['POST', 'validate'],
    ]) expect(proxyPathIsFleetGlobal(request(`/api/proxy/admin/tls/${path}`, undefined, method))).toBe(true);
    for (const [method, path] of [
      ['GET', 'unknown'], ['POST', 'inventory'], ['GET', 'inventory/extra'],
      ['PUT', 'acme/orders/id'], ['GET', 'acme/orders/id/finalize'],
      ['POST', 'certificates/id/extra'], ['GET', '../proxies'],
    ]) expect(proxyPathIsFleetGlobal(request(`/api/proxy/admin/tls/${path}`, undefined, method))).toBe(false);
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
