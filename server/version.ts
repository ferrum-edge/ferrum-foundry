import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  version?: unknown;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const metadata = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as PackageMetadata;
    return typeof metadata.version === 'string' ? metadata.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION = readVersion();
