import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, sep } from 'node:path';

export const MAX_CA_BUNDLE_BYTES = 1024 * 1024;

export interface CaBundle {
  path: string;
  pem: string;
  fingerprint: string;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/**
 * Resolve and read a CA bundle without following a final-component symlink.
 * The returned fingerprint is safe to use in dispatcher cache keys; the PEM
 * itself must never be logged or returned to an API client.
 */
export function loadCaBundle(
  requestedPath: string,
  configuredRoot?: string,
  maxBytes = MAX_CA_BUNDLE_BYTES,
): CaBundle {
  let canonicalPath: string;
  let canonicalRoot: string;

  try {
    if (lstatSync(requestedPath).isSymbolicLink()) {
      throw new Error('TLS CA bundle must not be a symbolic link');
    }
    canonicalPath = realpathSync(requestedPath);
    canonicalRoot = realpathSync(configuredRoot ?? dirname(canonicalPath));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TLS CA bundle')) throw error;
    throw new Error('TLS CA bundle path is not readable');
  }

  if (!isWithinRoot(canonicalPath, canonicalRoot)) {
    throw new Error('TLS CA bundle must be inside FERRUM_TLS_CA_ROOT');
  }

  let fd: number | undefined;
  try {
    fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('TLS CA bundle must be a regular file');
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`TLS CA bundle must be between 1 and ${maxBytes} bytes`);
    }

    const pem = readFileSync(fd, 'utf8');
    return {
      path: canonicalPath,
      pem,
      fingerprint: createHash('sha256').update(pem).digest('hex'),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TLS CA bundle')) {
      throw error;
    }
    throw new Error('TLS CA bundle path is not readable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
