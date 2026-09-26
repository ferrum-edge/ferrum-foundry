import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const runFile = promisify(execFile);

// This POSIX regression runs in hosted CI. Keep all potentially blocking CA
// calls in the child: only the parent can enforce a timeout on synchronous I/O.
describe.skipIf(process.platform === 'win32')('CA special-file validation', () => {
  it.each([false, true])('promptly rejects a non-regular CA through config, runtime and dispatcher (symlink=%s)', async (linked) => {
    const root = mkdtempSync(join(tmpdir(), 'foundry-ca-special-'));
    const fifo = join(root, 'special.pem');
    const selected = linked ? join(root, 'selected.pem') : fifo;
    try {
      execFileSync('mkfifo', [fifo], { timeout: 2_000, killSignal: 'SIGKILL', stdio: 'pipe' });
      if (linked) symlinkSync('special.pem', selected);
      const env = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !key.startsWith('FERRUM_') && key !== 'NODE_OPTIONS'));
      const source = `
        import assert from 'node:assert/strict';
        import { loadCaBundle } from ${JSON.stringify(new URL('./ca.ts', import.meta.url).href)};
        import { loadConfig, updateRuntimeConfig } from ${JSON.stringify(new URL('./config.ts', import.meta.url).href)};
        import { closeDispatchers, getDispatcher } from ${JSON.stringify(new URL('./tls.ts', import.meta.url).href)};
        const selected = process.env.FERRUM_TLS_CA_PATH;
        const root = process.env.FERRUM_TLS_CA_ROOT;
        const regularFileError = { message: 'TLS CA bundle must be a regular file' };
        async function promptly(operation) {
          const started = performance.now();
          await operation();
          assert.ok(performance.now() - started < 1000, 'CA rejection exceeded one second');
        }
        await promptly(() => assert.throws(() => loadCaBundle(selected, root), regularFileError));
        await promptly(() => assert.throws(() => loadConfig(), regularFileError));
        delete process.env.FERRUM_TLS_CA_PATH;
        const before = loadConfig();
        await promptly(() => assert.rejects(
          updateRuntimeConfig({ jwtIssuer: 'must-not-publish', tlsCaPath: selected }), regularFileError,
        ));
        assert.deepEqual(loadConfig(), before);
        await promptly(() => assert.throws(
          () => getDispatcher({ ...before, tlsCaPath: selected }), regularFileError,
        ));
        await closeDispatchers();
        console.log('validated all CA callers');
      `;
      // execFile's parent-owned timer uses SIGKILL even if the child's event
      // loop is blocked. Awaiting completion precedes removal of the fixture.
      const result = await runFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...env,
          NODE_ENV: 'test',
          FERRUM_AUTH_MODE: 'static',
          FERRUM_ADMIN_URL: 'https://initial.example',
          FERRUM_ADMIN_ALLOWED_ORIGINS: 'https://runtime.example',
          FERRUM_ALLOW_RUNTIME_SETTINGS: 'true',
          FERRUM_JWT_SECRET: 'ca-special-signing-fixture-at-least-32-characters',
          FERRUM_BFF_AUTH_TOKEN: 'ca-special-login-fixture-at-least-32-characters',
          FERRUM_TLS_CA_ROOT: root,
          FERRUM_TLS_CA_PATH: selected,
        },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      });
      expect(result.stdout.trim()).toBe('validated all CA callers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
