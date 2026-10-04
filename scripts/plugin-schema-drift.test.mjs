import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  compareProvenance,
  digestOf,
  extractSchemaBlock,
  schemaProducerExport,
} from "./plugin-schema-drift.mjs";
import {
  GUIDED_PLUGINS,
  PLUGIN_SCHEMA_PROVENANCE,
  PLUGIN_SCHEMA_SPEC,
  getGuidedSchema,
} from "../src/lib/pluginSchemas.ts";

const SPEC = [
  "components:",
  "  schemas:",
  "    KeyAuthConfig:",
  "      type: object",
  "      properties:",
  "        key_location:",
  "          type: string",
  "",
  "    NextComponent:",
  "      type: object",
  "",
].join("\n");

test("extracts a component block up to the next component", () => {
  assert.equal(
    extractSchemaBlock(SPEC, "KeyAuthConfig"),
    [
      "    KeyAuthConfig:",
      "      type: object",
      "      properties:",
      "        key_location:",
      "          type: string",
    ].join("\n"),
  );
});

test("a cosmetic change after the block does not register as drift", () => {
  const withTrailingBlanks = SPEC.replace("\n\n    NextComponent:", "\n\n\n    NextComponent:");
  assert.equal(
    digestOf(extractSchemaBlock(SPEC, "KeyAuthConfig")),
    digestOf(extractSchemaBlock(withTrailingBlanks, "KeyAuthConfig")),
  );
});

test("a change inside the block does register as drift", () => {
  const changed = SPEC.replace("type: string", "type: [string, 'null']");
  assert.notEqual(
    digestOf(extractSchemaBlock(SPEC, "KeyAuthConfig")),
    digestOf(extractSchemaBlock(changed, "KeyAuthConfig")),
  );
});

test("a removed component is reported as missing, not as unchanged", () => {
  const [finding] = compareProvenance(SPEC, [
    { component: "Vanished", sha256: "0".repeat(64) },
  ]);
  assert.equal(finding.status, "missing");
});

test("an unchanged component compares equal", () => {
  const block = extractSchemaBlock(SPEC, "KeyAuthConfig");
  const [finding] = compareProvenance(SPEC, [
    { component: "KeyAuthConfig", sha256: digestOf(block) },
  ]);
  assert.equal(finding.status, "unchanged");
});

test("every guided plugin's schema components are pinned", () => {
  const pinned = new Set(PLUGIN_SCHEMA_PROVENANCE.map((entry) => entry.component));
  for (const plugin of GUIDED_PLUGINS) {
    for (const component of getGuidedSchema(plugin).components) {
      assert.ok(
        pinned.has(component),
        `${plugin} models ${component}, which has no pinned digest`,
      );
    }
  }
});

test("every pinned digest is a full SHA-256", () => {
  for (const entry of PLUGIN_SCHEMA_PROVENANCE) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.component);
  }
});

test("the hosted export retains exact blocks and reports drift without inventing pins", () => {
  const ref = "a".repeat(40);
  const exported = schemaProducerExport(SPEC, ref);
  assert.equal(exported.source.ref, ref);
  assert.equal(exported.source.sha256, digestOf(SPEC));
  assert.equal(exported.reviewed_ref, PLUGIN_SCHEMA_SPEC.ref);
  const keyAuth = exported.components.find((entry) => entry.component === "KeyAuthConfig");
  assert.equal(keyAuth.yaml, extractSchemaBlock(SPEC, "KeyAuthConfig"));
  assert.equal(keyAuth.actual, digestOf(keyAuth.yaml));
  assert.equal(keyAuth.status, "changed");
  const missing = exported.components.find((entry) => entry.component === "RateLimitingConfig");
  assert.equal(missing.yaml, null);
  assert.equal(missing.actual, null);
  assert.equal(missing.status, "missing");
});

test("hosted producer uploads require both nonempty files and successful hashing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const hashStart = workflow.indexOf("      - name: Hash the hosted schema producer export\n");
  const uploadStart = workflow.indexOf("      - name: Upload the hosted schema producer export\n");
  const end = workflow.indexOf("      - name: Verify the plugin sensitivity table", uploadStart);
  assert.ok(hashStart > 0 && uploadStart > hashStart && end > uploadStart);
  const hash = workflow.slice(hashStart, uploadStart);
  assert.match(hash, /id: schema-hash\n/);
  // Drift remains a failing job, but its valid exporter output can be hashed.
  assert.match(hash, /always\(\) && steps\.guided-schemas\.outcome != 'skipped'/);
  assert.match(
    hash,
    /test -s plugin-schema-producer\.json\n\s+sha256sum plugin-schema-producer\.json > plugin-schema-producer\.json\.sha256\n\s+test -s plugin-schema-producer\.json\.sha256/,
  );
  const upload = workflow.slice(uploadStart, end);
  assert.match(upload, /if: \$\{\{ always\(\) && steps\.schema-hash\.outcome == 'success' \}\}/);
  assert.match(
    upload,
    /name: plugin-schema-producer-\$\{\{ github\.sha \}\}-attempt-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    upload,
    /path: \|\n\s+\$\{\{ runner\.temp \}\}\/plugin-schema-producer\.json\n\s+\$\{\{ runner\.temp \}\}\/plugin-schema-producer\.json\.sha256/,
  );
  assert.match(upload, /if-no-files-found: error/);
  assert.doesNotMatch(upload, /overwrite:|continue-on-error:/);
});

test("hosted qualification exposes the tested checkout SHA independently of the PR head", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const source = workflow.slice(
    workflow.indexOf("  qualification-source:"),
    workflow.indexOf("  quality:"),
  );
  assert.match(source, /name: Qualification Source \(\$\{\{ github\.sha \}\}\)/);
  assert.match(source, /run: test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.doesNotMatch(source, /continue-on-error:|\n\s+if:/);
});
