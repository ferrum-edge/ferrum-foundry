import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { signAdminJwt } from '../shared/admin-jwt.js';
import {
  isNamespaceName,
  NAMESPACE_DESCRIPTION_MAX_LENGTH,
  NAMESPACE_NAME_MAX_LENGTH,
  namespaceDescriptionProblem,
  normalizeNamespaceDescription,
} from '../shared/namespace.js';
import type { AuthPrincipal } from './auth-types.js';
import {
  authorizeRegistryBody,
  authorizeRegistryPath,
  RegistryRequestError,
} from './namespace-registry.js';

const INVALID_NAMESPACE_PATTERN = /invalid namespace/;
const SECRET = 'namespace-policy-test-secret-at-least-32-bytes';

// Edge's grammar: ^[a-zA-Z0-9][a-zA-Z0-9._-]*$, 1-254 characters.
const NAME_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ['a', true],
  ['9lives', true],
  ['ns1.prod_eu-west', true],
  ['a'.repeat(NAMESPACE_NAME_MAX_LENGTH), true],
  ['a'.repeat(NAMESPACE_NAME_MAX_LENGTH + 1), false],
  ['', false],
  ['.prod', false],
  ['-prod', false],
  ['_prod', false],
  ['a\n', false],
  ['\na', false],
  ['*', false],
  ['tenant-*', false],
  ['tenant a', false],
  ['prod/eu', false],
  ['émeraude', false],
];

const ADMIN: AuthPrincipal = {
  subject: 'admin',
  displayName: 'admin',
  role: 'admin',
  namespaces: undefined,
  authMode: 'static',
};

function registryStatus(run: () => unknown): number | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof RegistryRequestError) return error.status;
    throw error;
  }
}

describe('shared namespace name rule', () => {
  it('is 254 characters', () => {
    expect(NAMESPACE_NAME_MAX_LENGTH).toBe(254);
  });

  it.each(NAME_CASES)('isNamespaceName(case %#) is %s', (name, valid) => {
    expect(isNamespaceName(name)).toBe(valid);
  });

  it('refuses a value that is not a string instead of coercing it', () => {
    for (const value of [undefined, null, 1, ['a'], { toString: () => 'a' }]) {
      expect(isNamespaceName(value)).toBe(false);
    }
  });

  // Each caller keeps its own answer to the same verdict.
  it.each(NAME_CASES)('the registry path and body refuse case %# with 400, the signer after trimming', async (name, valid) => {
    const pathStatus = registryStatus(() => authorizeRegistryPath(`/namespaces/${name}`, 'GET', ADMIN));
    expect(pathStatus).toBe(valid ? undefined : 400);
    const bodyStatus = registryStatus(() => authorizeRegistryBody(
      Buffer.from(JSON.stringify({ name })),
      'POST',
      ADMIN,
    ));
    expect(bodyStatus).toBe(valid ? undefined : 400);
    const signed = signAdminJwt({
      secret: SECRET,
      issuer: 'foundry',
      subject: 'tester',
      role: 'admin',
      namespaces: [name],
      ttlSeconds: 60,
    });
    // The signer trims entries first (so `a\n` signs as `a`); an empty entry
    // fails its own non-empty rule.
    if (isNamespaceName(name.trim())) await expect(signed).resolves.toEqual(expect.any(String));
    else await expect(signed).rejects.toThrow();
  });

  it('keeps the signer trimming and de-duplicating names before it checks them', async () => {
    const token = await signAdminJwt({
      secret: SECRET,
      issuer: 'foundry',
      subject: 'tester',
      role: 'admin',
      namespaces: [' tenant-a ', 'tenant-a'],
      ttlSeconds: 60,
    });
    expect(decodeJwt(token).ns).toBe('tenant-a');
    await expect(signAdminJwt({
      secret: SECRET,
      issuer: 'foundry',
      subject: 'tester',
      role: 'admin',
      namespaces: ['*'],
      ttlSeconds: 60,
    })).rejects.toThrow(INVALID_NAMESPACE_PATTERN);
  });
});

describe('shared namespace description rule', () => {
  it('is 1024 Unicode scalar values', () => {
    expect(NAMESPACE_DESCRIPTION_MAX_LENGTH).toBe(1024);
  });

  it('trims Unicode White_Space like Rust str::trim, not JS trim', () => {
    expect(normalizeNamespaceDescription('\u0085 team 　\n')).toBe('team');
    // BOM is not White_Space, so Edge keeps it although JS trim() strips it.
    expect(normalizeNamespaceDescription('﻿team﻿')).toBe('﻿team﻿');
  });

  it.each([
    ['', null],
    ['ok', null],
    ['😀'.repeat(1024), null],
    ['😀'.repeat(1025), 'too-long'],
    [`  ${'a'.repeat(1024)}\u0085`, null],
    ['\u0085'.repeat(1025), null],
    ['﻿'.repeat(1025), 'too-long'],
    ['\ud800', 'invalid-unicode'],
    ['ok\udc00', 'invalid-unicode'],
    [`\ud800${'a'.repeat(1025)}`, 'invalid-unicode'],
  ] as const)('namespaceDescriptionProblem(case %#) is %s', (description, problem) => {
    expect(namespaceDescriptionProblem(description)).toBe(problem);
  });

  it('maps each problem to the registry 400 and forwards the untrimmed original', () => {
    const body = (description: string) => Buffer.from(JSON.stringify({ description }));
    expect(() => authorizeRegistryBody(body('\ud800'), 'PUT', ADMIN))
      .toThrow(new RegistryRequestError(400, 'Invalid namespace description'));
    expect(() => authorizeRegistryBody(body('😀'.repeat(1025)), 'PUT', ADMIN))
      .toThrow(new RegistryRequestError(400, 'Namespace description exceeds 1024 characters'));
    // Unlike the SPA, which sends the normalized text, the BFF only checks.
    expect(JSON.parse(authorizeRegistryBody(body('\u0085 team '), 'PUT', ADMIN)))
      .toEqual({ description: '\u0085 team ' });
  });
});
