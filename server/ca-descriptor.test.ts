import {
  appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCaBundle } from './ca.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    closeSync: vi.fn(original.closeSync),
    readSync: vi.fn(original.readSync),
  };
});

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'foundry-ca-descriptor-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectDescriptorClosed() {
  const fd = vi.mocked(openSync).mock.results.at(-1)?.value as number;
  expect(closeSync).toHaveBeenCalledWith(fd);
  expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
}

describe('bounded CA descriptor reads', () => {
  it.each(['valid', 'invalid', 'empty', 'oversized', 'directory'])('closes its descriptor after %s validation', (kind) => {
    const path = kind === 'directory' ? root : join(root, 'ca.pem');
    if (kind !== 'directory') {
      writeFileSync(path, kind === 'valid' ? rootCertificates[0]!
        : kind === 'empty' ? '' : kind === 'oversized' ? Buffer.alloc(8193) : 'invalid certificate');
    }
    if (kind === 'valid') expect(loadCaBundle(path, root, 8192).pem).toBe(rootCertificates[0]);
    else expect(() => loadCaBundle(path, root, 8192)).toThrow(/TLS CA bundle/);
    if (['empty', 'oversized', 'directory'].includes(kind)) expect(readSync).not.toHaveBeenCalled();
    expectDescriptorClosed();
  });

  it('bounds reads when a regular file grows after descriptor validation', async () => {
    const path = join(root, 'ca.pem');
    const pem = rootCertificates[0]!;
    writeFileSync(path, pem);
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
      appendFileSync(path, Buffer.alloc(16 * 1024));
      return original.readSync(...args);
    });
    expect(() => loadCaBundle(path, root)).toThrow(/changed while it was being read/);
    expect(readSync).toHaveBeenCalledTimes(1);
    const buffer = vi.mocked(readSync).mock.calls[0][1] as Buffer;
    expect(buffer.length).toBe(Buffer.byteLength(pem) + 1);
    expectDescriptorClosed();
  });

  it('accepts a valid bundle exactly at the byte limit', () => {
    const path = join(root, 'ca.pem');
    const pem = rootCertificates[0]!;
    writeFileSync(path, pem);
    expect(loadCaBundle(path, root, Buffer.byteLength(pem)).pem).toBe(pem);
    expectDescriptorClosed();
  });

  it('closes the descriptor when reading fails', () => {
    const path = join(root, 'ca.pem');
    writeFileSync(path, rootCertificates[0]!);
    vi.mocked(readSync).mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(() => loadCaBundle(path, root)).toThrow('TLS CA bundle path is not readable');
    expectDescriptorClosed();
  });

  it('handles short descriptor reads without truncating the certificate', async () => {
    const path = join(root, 'ca.pem');
    writeFileSync(path, rootCertificates[0]!);
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readSync).mockImplementationOnce((fd, buffer) => original.readSync(fd, buffer, 0, 7, null));
    expect(loadCaBundle(path, root).pem).toBe(rootCertificates[0]);
    expect(readSync).toHaveBeenCalledTimes(3);
    expectDescriptorClosed();
  });
});
