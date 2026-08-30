import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    writeFileSync(path, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
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

  it('rejects symlinks and oversized files', () => {
    const root = tempDirectory();
    const target = join(root, 'target.pem');
    const link = join(root, 'link.pem');
    writeFileSync(target, 'certificate');
    symlinkSync(target, link);
    expect(() => loadCaBundle(link, root)).toThrow(/symbolic link/);

    const large = join(root, 'large.pem');
    writeFileSync(large, Buffer.alloc(1025));
    expect(() => loadCaBundle(large, root, 1024)).toThrow(/between 1 and 1024/);
  });
});
