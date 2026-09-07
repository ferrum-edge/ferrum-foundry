import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { proxyPathIsFleetGlobal, proxyTargetPath, proxyTargetUrl, UnsafeProxyPathError } from './proxy-path.js';

function request(url: string, wildcard?: string, method = 'GET'): FastifyRequest {
  return {
    raw: { url }, url, method,
    params: wildcard === undefined ? {} : { '*': wildcard },
    routeOptions: { url: wildcard === undefined ? url.split('?')[0] : '/api/proxy/*' },
  } as FastifyRequest;
}

describe('canonical proxy targets', () => {
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
