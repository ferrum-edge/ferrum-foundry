import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCaBundle } from './ca.js';

const directories: string[] = [];

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'foundry-ca-test-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('loadCaBundle', () => {
  it('reads and fingerprints a bounded regular file under the approved root', () => {
    const root = tempDirectory();
    const path = join(root, 'ca.pem');
    writeFileSync(path, rootCertificates[0]!);
    const bundle = loadCaBundle(path, root);
    expect(bundle.path).toBe(realpathSync(path));
    expect(bundle.pem).toContain('BEGIN CERTIFICATE');
    expect(bundle.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects traversal outside the approved root', () => {
    const root = tempDirectory();
    const outside = tempDirectory();
    const path = join(outside, 'ca.pem');
    writeFileSync(path, 'certificate');
    expect(() => loadCaBundle(path, root)).toThrow(/inside FERRUM_TLS_CA_ROOT/);
  });

  it('supports a projected-volume symlink whose target remains inside the approved root', () => {
    const root = tempDirectory();
    const target = join(root, 'target.pem');
    const link = join(root, 'link.pem');
    writeFileSync(target, rootCertificates[0]!);
    symlinkSync(target, link);
    const bundle = loadCaBundle(link, root);
    expect(bundle.path).toBe(realpathSync(target));
    expect(bundle.pem).toBe(rootCertificates[0]);
  });

  it('rejects a projected-volume symlink whose target escapes the approved root', () => {
    const root = tempDirectory();
    const outside = tempDirectory();
    const target = join(outside, 'target.pem');
    const link = join(root, 'link.pem');
    writeFileSync(target, rootCertificates[0]!);
    symlinkSync(target, link);
    expect(() => loadCaBundle(link, root)).toThrow(/inside FERRUM_TLS_CA_ROOT/);
  });

  it('accepts multiple certificates with whitespace and hash comments', () => {
    const root = tempDirectory();
    const path = join(root, 'ca.pem');
    const pem = `# approved roots\n${rootCertificates[0]}\n\n# second root\n${rootCertificates[1]}\n`;
    writeFileSync(path, pem);
    expect(loadCaBundle(path, root).pem).toBe(pem);
  });

  it.each([
    'not a PEM certificate',
    '-----BEGIN CERTIFICATE-----\ntruncated',
    '-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----',
    `${rootCertificates[0]}\n-----BEGIN CERTIFICATE-----\ntruncated`,
  ])('rejects malformed certificate material without exposing the path', (pem) => {
    const root = tempDirectory();
    const path = join(root, 'ca.pem');
    writeFileSync(path, pem);
    expect(() => loadCaBundle(path, root)).toThrow('TLS CA bundle must contain valid PEM certificates');
  });

  it('rejects oversized files', () => {
    const root = tempDirectory();
    const large = join(root, 'large.pem');
    writeFileSync(large, Buffer.alloc(1025));
    expect(() => loadCaBundle(large, root, 1024)).toThrow(/between 1 and 1024/);
  });
});
