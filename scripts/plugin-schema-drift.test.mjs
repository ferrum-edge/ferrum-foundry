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

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ID_SCHEMA_HASH_PATTERN = /id: schema-hash\n/;
const ALWAYS_STEPS_GUIDED_SCHEMAS_OUTCOME_PATTERN =
  /always\(\) && steps\.guided-schemas\.outcome != 'skipped'/;
const TEST_PLUGIN_SCHEMA_PRODUCER_JSON_PATTERN =
  /test -s plugin-schema-producer\.json\n\s+sha256sum plugin-schema-producer\.json > plugin-schema-producer\.json\.sha256\n\s+test -s plugin-schema-producer\.json\.sha256/;
const IF_ALWAYS_STEPS_SCHEMA_HASH_PATTERN =
  /if: \$\{\{ always\(\) && steps\.schema-hash\.outcome == 'success' \}\}/;
const NAME_PLUGIN_SCHEMA_PRODUCER_GITHUB_PATTERN =
  /name: plugin-schema-producer-\$\{\{ github\.sha \}\}-attempt-\$\{\{ github\.run_attempt \}\}/;
const PATH_RUNNER_TEMP_PLUGIN_SCHEMA_PATTERN =
  /path: \|\n\s+\$\{\{ runner\.temp \}\}\/plugin-schema-producer\.json\n\s+\$\{\{ runner\.temp \}\}\/plugin-schema-producer\.json\.sha256/;
const IF_NO_FILES_FOUND_ERROR_PATTERN = /if-no-files-found: error/;
const OVERWRITE_CONTINUE_ON_ERROR_PATTERN = /overwrite:|continue-on-error:/;
const NAME_QUALIFICATION_SOURCE_GITHUB_SHA_PATTERN =
  /name: Qualification Source \(\$\{\{ github\.sha \}\}; source /;
const SOURCE_GITHUB_EVENT_PULL_REQUEST_HEAD_PATTERN =
  /source \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/;
const BASE_GITHUB_EVENT_PULL_REQUEST_SHA_PATTERN =
  /base \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/;
const REF_GITHUB_EVENT_PULL_REQUEST_BASE_PATTERN =
  /ref \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.ref_name \}\}\)/;
const FETCH_DEPTH_2_PATTERN = /fetch-depth: 2/;
const TEST_GIT_REV_PARSE_HEAD_PATTERN = /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/;
const TEST_GIT_REV_PARSE_HEAD_1_PATTERN =
  /test "\$\(git rev-parse HEAD\^1\)" = "\$QUALIFICATION_BASE"/;
const TEST_GIT_REV_PARSE_HEAD_2_PATTERN =
  /test "\$\(git rev-parse HEAD\^2\)" = "\$QUALIFICATION_SOURCE"/;
const CONTINUE_ON_ERROR_IF_PATTERN = /continue-on-error:|\n\s+if:/;

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
    assert.match(entry.sha256, SHA256_HEX_PATTERN, entry.component);
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
  assert.match(hash, ID_SCHEMA_HASH_PATTERN);
  // Drift remains a failing job, but its valid exporter output can be hashed.
  assert.match(hash, ALWAYS_STEPS_GUIDED_SCHEMAS_OUTCOME_PATTERN);
  assert.match(
    hash,
    TEST_PLUGIN_SCHEMA_PRODUCER_JSON_PATTERN,
  );
  const upload = workflow.slice(uploadStart, end);
  assert.match(upload, IF_ALWAYS_STEPS_SCHEMA_HASH_PATTERN);
  assert.match(
    upload,
    NAME_PLUGIN_SCHEMA_PRODUCER_GITHUB_PATTERN,
  );
  assert.match(
    upload,
    PATH_RUNNER_TEMP_PLUGIN_SCHEMA_PATTERN,
  );
  assert.match(upload, IF_NO_FILES_FOUND_ERROR_PATTERN);
  assert.doesNotMatch(upload, OVERWRITE_CONTINUE_ON_ERROR_PATTERN);
});

test("hosted qualification captures original tested, source and base identities", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const source = workflow.slice(
    workflow.indexOf("  qualification-source:"),
    workflow.indexOf("  quality:"),
  );
  assert.match(source, NAME_QUALIFICATION_SOURCE_GITHUB_SHA_PATTERN);
  assert.match(source, SOURCE_GITHUB_EVENT_PULL_REQUEST_HEAD_PATTERN);
  assert.match(source, BASE_GITHUB_EVENT_PULL_REQUEST_SHA_PATTERN);
  assert.match(source, REF_GITHUB_EVENT_PULL_REQUEST_BASE_PATTERN);
  assert.match(source, FETCH_DEPTH_2_PATTERN);
  assert.match(source, TEST_GIT_REV_PARSE_HEAD_PATTERN);
  assert.match(source, TEST_GIT_REV_PARSE_HEAD_1_PATTERN);
  assert.match(source, TEST_GIT_REV_PARSE_HEAD_2_PATTERN);
  assert.doesNotMatch(source, CONTINUE_ON_ERROR_IF_PATTERN);
});
