import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  driftMarkdown,
  edgeMainDrift,
  edgeMainDriftAt,
  FOUNDRY_TRIGGER_PREDICATES,
} from "./edge-main-drift.mjs";
import {
  TRIGGER_CLIENT_FIELD_PREDICATES,
  TRIGGER_VISIBLE_PREDICATES,
} from "../src/lib/resourceBaseline.ts";
import { digestOf, extractSchemaBlock } from "./plugin-schema-drift.mjs";
import { PLUGIN_SCHEMA_SPEC } from "../src/lib/pluginSchemas.ts";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";

const KEY_AUTH_CHANGED_PATTERN = /component `KeyAuthConfig`: changed/;
const RATE_LIMITING_MISSING_PATTERN = /component `RateLimitingConfig`: missing/;
const CORS_MISSING_PATTERN = /entry `cors`: missing/;
const UNKNOWN_SENSITIVITY_PATTERN = /unreadable \(FieldSensitivity::QuantumSealed is not one Foundry implements/;
const FORTY_HEX_PATTERN = /expected a 40-hex Edge commit/;
const SUBSET_MISSING_PATTERN =
  /component `SubsetTrafficPolicy` readOnly fields: missing `max_retries`/;
const TRIGGER_MISSING_PATTERN =
  /constant `TRIGGER_VISIBLE_PREDICATES`: missing `device_posture`/;
const TRIGGER_UNREADABLE_PATTERN =
  /constant `TRIGGER_CLIENT_FIELD_PREDICATES`: unreadable \(`TRIGGER_CLIENT_FIELD_PREDICATES` not found/;
const SUBSET_UNREADABLE_PATTERN =
  /component `SubsetTrafficPolicy` readOnly fields: unreadable \(`SubsetTrafficPolicy` not found/;
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
  "    SubsetTrafficPolicy:",
  "      type: object",
  "      properties:",
  "        hash_on:",
  "          type: string",
  "        tls:",
  "          type: object",
  "          readOnly: true",
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

/// See [\`TRIGGER_VISIBLE_PREDICATES\`].
pub const TRIGGER_CLIENT_FIELD_PREDICATES: &[&str] = &["header", "query", "cookie"];

const TRIGGER_VISIBLE_PREDICATES: &[&str] = &[
    "method",
    // a comment between entries
    "path",
];
`;

const FOUNDRY = {
  schemas: new Map([
    ["key_auth", [{ path: ["key"], sensitivity: "secret" }]],
    ["cors", []],
  ]),
  kafka: new Set(["acks"]),
};

const TRIGGER_PREDICATES = {
  TRIGGER_CLIENT_FIELD_PREDICATES: ["header", "query", "cookie"],
  TRIGGER_VISIBLE_PREDICATES: ["path", "method"],
};

const options = {
  provenance: PROVENANCE,
  foundry: FOUNDRY,
  serverOwned: ["tls"],
  triggerPredicates: TRIGGER_PREDICATES,
};

test("matching content is clean, though no recorded ref names the Edge main commit", () => {
  const result = edgeMainDrift(SPEC, PROJECTION, options);
  assert.deepEqual(result, {
    schemas: [],
    sensitivity: [],
    subset: [],
    trigger: [],
    drifted: false,
  });
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

test("a server-owned subset field Edge adds, or a SubsetTrafficPolicy it removes, is drift", () => {
  const added = SPEC.replace(
    "          readOnly: true\n",
    "          readOnly: true\n        max_retries:\n          type: integer\n          readOnly: true\n",
  );
  const result = edgeMainDrift(added, PROJECTION, options);
  assert.equal(result.drifted, true);
  assert.deepEqual(result.schemas, []);
  assert.deepEqual(result.sensitivity, []);
  assert.deepEqual(result.subset, [{ status: "missing", fields: ["max_retries"] }]);
  assert.match(driftMarkdown(result), SUBSET_MISSING_PATTERN);

  const removed = SPEC.replace("    SubsetTrafficPolicy:\n", "    SubsetPolicy:\n");
  const unreadable = edgeMainDrift(removed, PROJECTION, options);
  assert.equal(unreadable.drifted, true);
  assert.deepEqual(unreadable.subset.map(({ status }) => status), ["unreadable"]);
  assert.match(driftMarkdown(unreadable), SUBSET_UNREADABLE_PATTERN);
});

test("a trigger predicate Edge adds, drops, or stops declaring as a list is drift", () => {
  const added = PROJECTION.replace('    "path",\n', '    "path",\n    "device_posture",\n');
  const result = edgeMainDrift(SPEC, added, options);
  assert.equal(result.drifted, true);
  assert.deepEqual(result.trigger, [
    { constant: "TRIGGER_VISIBLE_PREDICATES", status: "missing", predicates: ["device_posture"] },
  ]);
  assert.match(driftMarkdown(result), TRIGGER_MISSING_PATTERN);

  const dropped = PROJECTION.replace('&["header", "query", "cookie"]', '&["header", "query"]');
  assert.deepEqual(edgeMainDrift(SPEC, dropped, options).trigger, [
    { constant: "TRIGGER_CLIENT_FIELD_PREDICATES", status: "extra", predicates: ["cookie"] },
  ]);

  const renamed = PROJECTION.replace(
    "pub const TRIGGER_CLIENT_FIELD_PREDICATES",
    "pub const TRIGGER_CLIENT_FIELDS",
  );
  const unreadable = edgeMainDrift(SPEC, renamed, options);
  assert.deepEqual(
    unreadable.trigger.map(({ constant, status }) => [constant, status]),
    [["TRIGGER_CLIENT_FIELD_PREDICATES", "unreadable"]],
  );
  assert.match(driftMarkdown(unreadable), TRIGGER_UNREADABLE_PATTERN);

  // A stale declaration left in a comment above the active one is not read.
  const stale = PROJECTION.replace(
    "const TRIGGER_VISIBLE_PREDICATES: &[&str] = &[",
    '// const TRIGGER_VISIBLE_PREDICATES: &[&str] = &["method", "path"];\n' +
      "/* const TRIGGER_VISIBLE_PREDICATES: &[&str] = &[\"method\", \"path\"]; */\n" +
      'const TRIGGER_VISIBLE_PREDICATES: &[&str] = &[\n    "device_posture",',
  );
  assert.deepEqual(edgeMainDrift(SPEC, stale, options).trigger, [
    { constant: "TRIGGER_VISIBLE_PREDICATES", status: "missing", predicates: ["device_posture"] },
  ]);

  // The literal must end at its declaration's semicolon.
  const extended = PROJECTION.replace(
    '&["header", "query", "cookie"];',
    '&["header", "query", "cookie"] + EXTRA;',
  );
  assert.deepEqual(
    edgeMainDrift(SPEC, extended, options).trigger.map(({ constant, status }) => [constant, status]),
    [["TRIGGER_CLIENT_FIELD_PREDICATES", "unreadable"]],
  );

  // An escaped literal is refused rather than read with its backslash
  // dropped: Rust compiles `"heade\r"` to a carriage return, which dropping
  // the backslash would read as the unchanged `header`.
  const escaped = PROJECTION.replace('&["header",', '&["heade\\r",');
  assert.ok(escaped.includes('"heade\\r"'));
  assert.deepEqual(
    edgeMainDrift(SPEC, escaped, options).trigger.map(({ constant, status, reason }) =>
      [constant, status, reason.includes("has an escape")]),
    [["TRIGGER_CLIENT_FIELD_PREDICATES", "unreadable", true]],
  );

  const notAList = PROJECTION.replace(
    '&["header", "query", "cookie"]',
    "CLIENT_FIELDS",
  );
  assert.deepEqual(
    edgeMainDrift(SPEC, notAList, options).trigger.map(({ status }) => status),
    ["unreadable"],
  );
});

test("Foundry's trigger predicate lists are the disjoint ones its redaction uses", () => {
  assert.deepEqual(FOUNDRY_TRIGGER_PREDICATES, {
    TRIGGER_CLIENT_FIELD_PREDICATES,
    TRIGGER_VISIBLE_PREDICATES,
  });
  assert.deepEqual(
    TRIGGER_CLIENT_FIELD_PREDICATES.filter((key) => TRIGGER_VISIBLE_PREDICATES.includes(key)),
    [],
  );
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
  "Verify the server-owned subset traffic_policy fields against the pinned Edge spec",
  "Resolve the pinned Ferrum Edge image",
]);
const USES_ONLY = new Set(["Setup Node.js"]);
const RENAMED = new Map([["Start pinned Ferrum Edge gateway", "Start Ferrum Edge main gateway"]]);
/** Steps only the Edge main check has. */
const OWN = [
  "Install Cosign",
  "Resolve the Ferrum Edge main image",
  "Compare the plugin schemas, sensitivity table and server-owned subset fields with Edge main",
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
