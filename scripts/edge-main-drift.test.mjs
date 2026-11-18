import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { driftMarkdown, edgeMainDrift, edgeMainDriftAt } from "./edge-main-drift.mjs";
import { digestOf, extractSchemaBlock } from "./plugin-schema-drift.mjs";
import { PLUGIN_SCHEMA_SPEC } from "../src/lib/pluginSchemas.ts";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";

const KEY_AUTH_CHANGED_PATTERN = /component `KeyAuthConfig`: changed/;
const RATE_LIMITING_MISSING_PATTERN = /component `RateLimitingConfig`: missing/;
const CORS_MISSING_PATTERN = /entry `cors`: missing/;
const UNKNOWN_SENSITIVITY_PATTERN = /unreadable \(FieldSensitivity::QuantumSealed is not one Foundry implements/;
const FORTY_HEX_PATTERN = /expected a 40-hex Edge commit/;
const SCHEDULE_PATTERN = /\n {2}schedule:\n {4}- cron: "[0-9]+ [0-9]+ \* \* [0-6]"\n {2}workflow_dispatch:\n/;
const ISSUES_WRITE_PATTERN = /issues: write/g;
const WRITE_PERMISSION_PATTERN = /: write/;
const COSIGN_IDENTITY_PATTERN =
  /--certificate-identity https:\/\/github\.com\/ferrum-edge\/ferrum-edge\/\.github\/workflows\/main-latest-image\.yml@refs\/heads\/main/;
const EDGE_IMAGE_ENV_PATTERN = /echo "FERRUM_EDGE_IMAGE=\$image" >> "\$GITHUB_ENV"/;
const PULL_REQUEST_GUARD_PATTERN = /github\.event_name != 'pull_request'/;
const SECRETS_PATTERN = /secrets\./;
const MATCH_PATTERN = /match/;
const STEP_END_PATTERN = /\n {6}- |\n\n {2}[a-z-]+:\n/;
const STEP_BODY_PATTERN = /\n {8}(?:env|run):/;
const JOB_START_PATTERN = /\n {2}[a-z][a-z0-9-]*:\n/;
const STEP_NAME_PATTERN = /^ {6}- name: (.+)$/gm;

const SPEC = [
  "components:",
  "  schemas:",
  "    KeyAuthConfig:",
  "      type: object",
  "      properties:",
  "        key_location:",
  "          type: string",
  "",
  "    RateLimitingConfig:",
  "      type: object",
  "",
].join("\n");

const PROVENANCE = [
  { component: "KeyAuthConfig", sha256: digestOf(extractSchemaBlock(SPEC, "KeyAuthConfig")) },
  {
    component: "RateLimitingConfig",
    sha256: digestOf(extractSchemaBlock(SPEC, "RateLimitingConfig")),
  },
];

/** Shaped like Edge's `plugin_config_projection.rs`. */
const PROJECTION = `
const fn secret(path: &'static [&'static str]) -> SensitivityRule {
    SensitivityRule {
        path,
        sensitivity: FieldSensitivity::Secret,
    }
}

const NONE: &[SensitivityRule] = &[];

pub const PLUGIN_SENSITIVITY_SCHEMAS: &[(&str, &[SensitivityRule])] = &[
    ("key_auth", &[secret(&["key"])]),
    ("cors", NONE),
];

pub const KAFKA_SAFE_PRODUCER_PROPERTIES: &[&str] = &[
    "acks",
];
`;

const FOUNDRY = {
  schemas: new Map([
    ["key_auth", [{ path: ["key"], sensitivity: "secret" }]],
    ["cors", []],
  ]),
  kafka: new Set(["acks"]),
};

const options = { provenance: PROVENANCE, foundry: FOUNDRY };

test("matching content is clean, though no recorded ref names the Edge main commit", () => {
  const result = edgeMainDrift(SPEC, PROJECTION, options);
  assert.deepEqual(result, { schemas: [], sensitivity: [], drifted: false });
  assert.match(driftMarkdown(result), MATCH_PATTERN);
});

test("a changed or removed schema component is drift", () => {
  const changed = SPEC.replace("key_location:", "key_locations:").replace(
    "    RateLimitingConfig:\n",
    "    RateLimitConfig:\n",
  );
  const result = edgeMainDrift(changed, PROJECTION, options);
  assert.equal(result.drifted, true);
  assert.deepEqual(
    result.schemas.map(({ component, status }) => [component, status]),
    [
      ["KeyAuthConfig", "changed"],
      ["RateLimitingConfig", "missing"],
    ],
  );
  const markdown = driftMarkdown(result);
  assert.match(markdown, KEY_AUTH_CHANGED_PATTERN);
  assert.match(markdown, RATE_LIMITING_MISSING_PATTERN);
});

test("a sensitivity table difference is drift", () => {
  const foundry = { ...FOUNDRY, schemas: new Map([...FOUNDRY.schemas].slice(0, 1)) };
  const result = edgeMainDrift(SPEC, PROJECTION, { ...options, foundry });
  assert.equal(result.drifted, true);
  assert.deepEqual(result.schemas, []);
  assert.deepEqual(
    result.sensitivity.map(({ plugin, status }) => [plugin, status]),
    [["cors", "missing"]],
  );
  assert.match(driftMarkdown(result), CORS_MISSING_PATTERN);
});

test("a projection table shape Foundry does not implement is drift, not a failed run", () => {
  const projection = PROJECTION.replace(
    "FieldSensitivity::Secret",
    "FieldSensitivity::QuantumSealed",
  );
  const result = edgeMainDrift(SPEC, projection, options);
  assert.equal(result.drifted, true);
  assert.deepEqual(
    result.sensitivity.map(({ plugin, status }) => [plugin, status]),
    [["PLUGIN_SENSITIVITY_SCHEMAS", "unreadable"]],
  );
  assert.match(driftMarkdown(result), UNKNOWN_SENSITIVITY_PATTERN);
});

test("fetches both Edge sources at the given commit and refuses anything else", async () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const fetched = [];
  const fetchSource = async (source, ref) => {
    fetched.push([source.path, ref]);
    return source === PLUGIN_SCHEMA_SPEC ? SPEC : PROJECTION;
  };
  const result = await edgeMainDriftAt(commit, { fetchSource });
  assert.equal(typeof result.drifted, "boolean");
  assert.deepEqual(fetched.sort(), [
    [PLUGIN_SCHEMA_SPEC.path, commit],
    [PLUGIN_SENSITIVITY_SOURCE.path, commit],
  ].sort());
  await assert.rejects(edgeMainDriftAt("main", { fetchSource }), FORTY_HEX_PATTERN);
  await assert.rejects(edgeMainDriftAt(undefined, { fetchSource }), FORTY_HEX_PATTERN);
});

/** The `env:`/`run:` text of the step named `name`, to the end of the step. */
function stepBody(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `no step named ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(STEP_END_PATTERN);
  const step = next < 0 ? rest : rest.slice(0, next);
  const body = step.search(STEP_BODY_PATTERN);
  assert.ok(body >= 0, `step ${name} has no env or run`);
  return step.slice(body).trimEnd();
}

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const drift = readFileSync(new URL("../.github/workflows/edge-main-drift.yml", import.meta.url), "utf8");

/** The text of job `id`, up to the next job of the workflow. */
function jobText(workflow, id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `no job ${id}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(JOB_START_PATTERN);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function stepNames(job) {
  return [...job.matchAll(STEP_NAME_PATTERN)].map(([, name]) => name);
}

/** Pinned Gateway Contract steps the Edge main check replaces with its own. */
const REPLACED = new Set([
  "Verify guided plugin schemas against the upstream spec",
  "Hash the hosted schema producer export",
  "Upload the hosted schema producer export",
  "Verify the plugin sensitivity table against the pinned Edge source",
  "Resolve the pinned Ferrum Edge image",
]);
const USES_ONLY = new Set(["Setup Node.js"]);
const RENAMED = new Map([["Start pinned Ferrum Edge gateway", "Start Ferrum Edge main gateway"]]);
/** Steps only the Edge main check has. */
const OWN = [
  "Install Cosign",
  "Resolve the Ferrum Edge main image",
  "Compare the plugin schemas and sensitivity table with Edge main",
  "Verify the editors' save payloads against the gateway",
  "Write the report",
];

test("the Edge main check runs every Pinned Gateway Contract step, verbatim, and nothing else", () => {
  // Derived from ci.yml, so adding or removing a gateway step there fails
  // here until the Edge main check follows in the same change.
  const pinned = stepNames(jobText(ci, "gateway-contract")).filter((name) => !REPLACED.has(name));
  const copied = pinned.map((name) => [name, RENAMED.get(name) ?? name]);
  assert.ok(copied.length >= 8, "the gateway-contract job was found");
  assert.deepEqual(
    stepNames(jobText(drift, "check")).sort(),
    [...copied.map(([, main]) => main), ...OWN].sort(),
  );
  for (const [ciName, mainName] of copied) {
    // A `uses:`-only step is compared by name above.
    if (USES_ONLY.has(ciName)) continue;
    assert.equal(stepBody(drift, mainName), stepBody(ci, ciName), `${mainName} differs from ci.yml's ${ciName}`);
  }
});

test("the Edge main workflow is scheduled, verifies the image, and writes issues only from one job", () => {
  assert.match(drift, SCHEDULE_PATTERN);
  assert.match(drift, COSIGN_IDENTITY_PATTERN);
  assert.match(drift, EDGE_IMAGE_ENV_PATTERN);
  assert.doesNotMatch(drift, SECRETS_PATTERN);
  const issueStart = drift.indexOf("\n  issue:\n");
  assert.ok(issueStart > 0);
  const check = drift.slice(0, issueStart);
  const issue = drift.slice(issueStart);
  assert.doesNotMatch(check, WRITE_PERMISSION_PATTERN);
  assert.equal(issue.match(ISSUES_WRITE_PATTERN)?.length, 1);
  assert.match(issue, PULL_REQUEST_GUARD_PATTERN);
});
