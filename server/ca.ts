import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
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
 * Resolve and read a CA bundle through a stable path contained by the approved
 * root. This supports projected-volume symlinks without allowing them to
 * escape the root. The PEM itself must never be logged or returned to a client.
 */
export function loadCaBundle(
  requestedPath: string,
  configuredRoot?: string,
  maxBytes = MAX_CA_BUNDLE_BYTES,
): CaBundle {
  let canonicalPath: string;
  let canonicalRoot: string;

  try {
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
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      throw new Error('TLS CA bundle must be a regular file');
    }
    if (before.size <= 0n || before.size > BigInt(maxBytes)) {
      throw new Error(`TLS CA bundle must be between 1 and ${maxBytes} bytes`);
    }

    const contents = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = realpathSync(requestedPath);
    const rootAfter = realpathSync(configuredRoot ?? dirname(pathAfter));
    const pathStat = statSync(canonicalPath, { bigint: true });
    if (contents.length <= 0 || contents.length > maxBytes) {
      throw new Error(`TLS CA bundle must be between 1 and ${maxBytes} bytes`);
    }
    if (
      pathAfter !== canonicalPath
      || rootAfter !== canonicalRoot
      || after.dev !== before.dev
      || after.ino !== before.ino
      || pathStat.dev !== before.dev
      || pathStat.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('TLS CA bundle changed while it was being read');
    }

    const pem = contents.toString('utf8');
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
