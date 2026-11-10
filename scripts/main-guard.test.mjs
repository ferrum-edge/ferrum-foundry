import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL("./", import.meta.url));
const MAIN_GUARD = "import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href";
const ARGV_COMPARISON_PATTERN = /import\.meta\.url\s*===[^\n]*process\.argv\[1\][^\n]*/g;

// `import.meta.url` is percent-encoded and symlink-resolved; `process.argv[1]`
// is neither. A guard that compares them without `realpathSync` and
// `pathToFileURL` skips `main` from a checkout path with a space or through a
// symlink, and the script exits 0 having checked nothing.
test("every script that runs main compares import.meta.url with the resolved argv[1]", () => {
  const scripts = readdirSync(SCRIPTS_DIR).filter(
    (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"),
  );
  const guarded = [];
  for (const name of scripts) {
    const source = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    const comparisons = source.match(ARGV_COMPARISON_PATTERN) ?? [];
    for (const comparison of comparisons) {
      assert.equal(comparison.trim(), MAIN_GUARD, `${name} compares argv[1] unresolved`);
    }
    if (comparisons.length > 0) guarded.push(name);
  }
  assert.ok(guarded.includes("plugin-schema-drift.mjs"));
  assert.ok(guarded.includes("plugin-sensitivity-drift.mjs"));
  assert.ok(guarded.includes("starter-preflight.mjs"));
});

test("a script run through a symlink in a path with a space still runs main", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-main-guard-"));
  try {
    const dir = join(root, "dir with space");
    mkdirSync(dir);
    const link = join(dir, "release-channel-tags.mjs");
    symlinkSync(join(SCRIPTS_DIR, "release-channel-tags.mjs"), link);
    const env = { ...process.env };
    delete env.RELEASE_TAG;
    const result = spawnSync(process.execPath, [link], { encoding: "utf8", env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /RELEASE_TAG is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
