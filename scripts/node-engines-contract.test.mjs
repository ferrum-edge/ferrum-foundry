import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const supportedNodeRange = '^22.22.2 || ^24.15.0 || >=26.0.0';

test('the advertised Node.js range includes the locked jsdom toolchain minimums', async () => {
  const [manifest, lockfile] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);

  assert.equal(manifest.engines.node, supportedNodeRange);
  assert.equal(lockfile.packages[''].engines.node, supportedNodeRange);

  for (const packageName of [
    'node_modules/jsdom',
    'node_modules/@asamuzakjp/css-color',
    'node_modules/@asamuzakjp/dom-selector',
  ]) {
    assert.equal(lockfile.packages[packageName].engines.node, supportedNodeRange, packageName);
  }
});
