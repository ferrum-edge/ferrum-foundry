import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_PLUGIN_CONFIGS,
  PLUGIN_METADATA,
  PLUGIN_PRIORITY,
} from "../src/lib/pluginConfigDefaults.ts";

const LINE_BREAK_PATTERN = /\r?\n/;
const CHECKSUM_LINE_PATTERN = /^sha256\s+([a-f0-9]{64})\s+(.+)$/;
const TAG_CONTRACTS_EDGE_R_PATTERN = /^tag=contracts-edge-[0-9.]+(?:-r[1-9][0-9]*)?$/m;
const PIN_COMMIT_PATTERN = /^commit=[a-f0-9]{40}$/m;
const PIN_TAG_CAPTURE_PATTERN = /^tag=(contracts-edge-[0-9.]+(?:-r[1-9][0-9]*)?)$/m;
const PINNED_CONTRACTS_TAG_PATTERN = /^tag=contracts-edge-0\.9\.20$/m;
const PINNED_CONTRACTS_COMMIT_PATTERN = /^commit=39da322083044c2e92617209e62983c92387f0ad$/m;
const EXISTING_SHARED_V1_PATTERN = /^EXISTING shared v1/;
const COMPONENTS_SCHEMAS_PATTERN = /^#\/components\/schemas\/[A-Za-z0-9]+$/;
const CONFIG_FROM_DEFAULT_PATTERN = /const config = getPluginConfigDefault\(name\);/;
const RANDOM_ENCRYPTION_SECRET_PATTERN =
  /config\.session\.encryption_secret = randomBytes\(32\)\.toString\("base64"\);/;
const REQUIRED_INPUTS_ASSERTION_PATTERN = /assertOnlyRequiredOperatorInputs\(name, config\);/;
const VERIFIED_CONFIG_SUBMISSION_PATTERN = /config,\s*\},\s*\}\);/;

const contractRoot = new URL("../contracts/ferrum-contracts/", import.meta.url);
const pinText = readFileSync(new URL("PIN", contractRoot), "utf8");
const pluginCatalog = JSON.parse(
  readFileSync(new URL("vocabularies/plugin-catalog.json", contractRoot), "utf8"),
);
const provisionedBy = JSON.parse(
  readFileSync(new URL("vocabularies/provisioned-by.json", contractRoot), "utf8"),
);

function pinnedFiles() {
  const files = new Map();
  for (const line of pinText.split(LINE_BREAK_PATTERN)) {
    const match = CHECKSUM_LINE_PATTERN.exec(line);
    if (match) files.set(match[2], match[1]);
  }
  return files;
}

// Which Ferrum Edge releases each contracts tag may back. An Edge release with
// no contract changes reuses the latest contracts tag (v0.9.10 ->
// contracts-edge-0.9.9), so this is a mapping, not string equality. Advance a
// tag here only after re-vendoring it; the test fails when the qualified Edge
// release in docs/compatibility.json has no tag that maps to it.
const CONTRACTS_TAG_EDGE_VERSIONS = {
  "contracts-edge-0.9.8": ["v0.9.8"],
  "contracts-edge-0.9.9": ["v0.9.9", "v0.9.10"],
  // r2 adds the proposed Alloy manifest and agents fields. Existing plugin
  // and provisioning vocabulary bytes/provenance are unchanged.
  "contracts-edge-0.9.9-r2": ["v0.9.9", "v0.9.10"],
  "contracts-edge-0.9.11": ["v0.9.11"],
  "contracts-edge-0.9.12": ["v0.9.12"],
  "contracts-edge-0.9.13": ["v0.9.13"],
  "contracts-edge-0.9.14": ["v0.9.14"],
  "contracts-edge-0.9.15": ["v0.9.15"],
  // Foundry moved from v0.9.15 straight to v0.9.20 (#686) and never vendored
  // contracts-edge-0.9.17 or contracts-edge-0.9.19.
  "contracts-edge-0.9.20": ["v0.9.20"],
};

function describeSetDrift(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const extra = [...actualSet].filter((name) => !expectedSet.has(name)).sort();
  const missing = [...expectedSet].filter((name) => !actualSet.has(name)).sort();
  assert.deepEqual(
    { extra, missing },
    { extra: [], missing: [] },
    `${label} differs from the pinned contract; extra: ${extra.join(", ") || "none"}; ` +
    `missing: ${missing.join(", ") || "none"}`);
}

test("vendored Ferrum Contracts files match their PIN digests", () => {
  assert.match(pinText, TAG_CONTRACTS_EDGE_R_PATTERN);
  assert.match(pinText, PIN_COMMIT_PATTERN);
  const files = pinnedFiles();
  const actualFiles = readdirSync(contractRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "PIN")
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(contractRoot.pathname.length))
    .sort();
  assert.equal(files.size, 18,
    "PIN must include the reviewed vocabularies, schema, fixtures and invalid expectations");
  assert.deepEqual([...files.keys()].sort(), actualFiles, "PIN must cover every vendored file");
  assert.equal(pinText.split(LINE_BREAK_PATTERN).filter((line) => line.startsWith("sha256")).length,
    files.size, "PIN must not contain duplicate entries");
  for (const [path, expected] of files) {
    const contents = readFileSync(new URL(path, contractRoot));
    const actual = createHash("sha256").update(contents).digest("hex");
    assert.equal(actual, expected, `${path} differs from its Ferrum Contracts PIN digest`);
  }
});

test("the contracts pin tracks the qualified Ferrum Edge release", () => {
  const tag = PIN_TAG_CAPTURE_PATTERN.exec(pinText)?.[1];
  assert.ok(tag, "PIN must name a contracts-edge tag");
  const compatibility = JSON.parse(
    readFileSync(new URL("../docs/compatibility.json", import.meta.url), "utf8"),
  );
  const edgeVersion = compatibility.edge?.release?.version;
  assert.ok(edgeVersion, "docs/compatibility.json must name the qualified Edge release version");
  const allowed = CONTRACTS_TAG_EDGE_VERSIONS[tag];
  assert.ok(
    allowed,
    `PIN tag ${tag} has no Edge-version mapping; re-vendor a contracts tag for ` +
      `${edgeVersion} and add it to CONTRACTS_TAG_EDGE_VERSIONS`,
  );
  assert.ok(
    allowed.includes(edgeVersion),
    `PIN tag ${tag} maps to ${allowed.join(", ")}, but docs/compatibility.json ` +
      `qualifies ${edgeVersion}`,
  );
});

test("the published manifest pin retains owner status and complete canonical integrity", () => {
  assert.match(pinText, PINNED_CONTRACTS_TAG_PATTERN);
  assert.match(pinText, PINNED_CONTRACTS_COMMIT_PATTERN);
  const schema = JSON.parse(readFileSync(
    new URL("schemas/service-manifest/v1.schema.json", contractRoot), "utf8",
  ));
  assert.equal(schema["x-contract"].status, "implemented");
  assert.match(schema["x-contract"].shared_status, EXISTING_SHARED_V1_PATTERN);
  assert.equal(schema["x-contract"].owner, "ferrum-edge/ferrum-alloy");
  assert.equal(schema["x-contract"].provenance[0].commit,
    "81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e");
  assert.equal(schema["x-contract"].provenance[0].availability, "unreleased");
  assert.equal(schema["x-contract"].coordinated_release.qualified_owner_commit,
    "81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e");
  assert.equal(pinnedFiles().get("schemas/service-manifest/v1.schema.json"),
    "3d086aec773345df3547adf6e026ad466168b27bf98163614d44171b7862b5dc");
  assert.equal(pinnedFiles().get("vocabularies/plugin-catalog.json"),
    "6263b10e8f327286d796dcea62cea59bb758458b5e1ce50069fcd5773fcf083a");
  assert.equal(pinnedFiles().get("vocabularies/provisioned-by.json"),
    "9f1b2ede95dd0e760662c285c3ac6d9f57e443a6847de935119cfa514a35613f");
  assert.equal(pinnedFiles().get("fixtures/invalid-expectations.json"),
    "01a73757e6c76d9a3de2c7ac42296726be443406fec53270a67422a2de5c76a3");
});

test("the vocabularies bind the published Edge source without changing attribution semantics", () => {
  const compatibility = JSON.parse(
    readFileSync(new URL("../docs/compatibility.json", import.meta.url), "utf8"),
  );
  for (const vocabulary of [pluginCatalog, provisionedBy]) {
    assert.equal(vocabulary.edge_release, compatibility.edge.release.version);
    for (const source of vocabulary.provenance) {
      assert.equal(source.repo, "ferrum-edge/ferrum-edge");
      assert.equal(source.ref, compatibility.edge.release.version);
      assert.equal(source.commit, compatibility.edge.source_commit);
    }
    assert.equal(Object.hasOwn(vocabulary, "main_branch_delta"), false);
  }
  assert.equal(pluginCatalog.config_schema_document.commit, compatibility.edge.source_commit);
  assert.equal(pluginCatalog.config_schema_document.sha256, compatibility.edge.release.openapi.sha256);
  assert.equal(provisionedBy.label.key, "provisioned-by");
  assert.equal(provisionedBy.label.available_since, "v0.9.5");
  assert.equal(provisionedBy.header.name, "X-Ferrum-Provisioned-By");
  assert.equal(provisionedBy.header.occurrences, 1);
  assert.equal(provisionedBy.header.max_length_bytes, 512);
  assert.equal(provisionedBy.header.control_characters, false);
  assert.equal(provisionedBy.header.trimmed, true);
  assert.equal(provisionedBy.open_set, true);
  assert.deepEqual(provisionedBy.values.map((entry) => entry.value), [
    "ferrum-edge-git-forge-ops", "ferrum-nexus", "ferrum-foundry",
  ]);
});

test("Foundry plugin metadata and defaults use the pinned plugin catalog", () => {
  const plugins = pluginCatalog.plugins;
  const metadataNames = Object.keys(PLUGIN_METADATA);
  const defaultNames = Object.keys(DEFAULT_PLUGIN_CONFIGS);
  const contractNames = plugins
    .filter((plugin) => plugin.classification !== "reserved")
    .map((plugin) => plugin.name);

  describeSetDrift(metadataNames, contractNames, "PLUGIN_METADATA names");
  describeSetDrift(defaultNames, metadataNames, "DEFAULT_PLUGIN_CONFIGS names");

  const pluginsByName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  for (const [name, config] of Object.entries(DEFAULT_PLUGIN_CONFIGS)) {
    const contractPlugin = pluginsByName.get(name);
    assert.ok(contractPlugin, `DEFAULT_PLUGIN_CONFIGS has extra plugin ${name}`);
    assert.match(
      contractPlugin.config_schema.pointer,
      COMPONENTS_SCHEMAS_PATTERN,
      `${name} has no valid config schema pointer in plugin-catalog.json`,
    );
    assert.ok(
      config && typeof config === "object" && !Array.isArray(config),
      `${name} default must be an object matching its config schema`);
  }

  // The Pinned Gateway Contract job submits defaults unchanged except for
  // declared, generated operator inputs, which are checked before submission.
  const gatewayContract = readFileSync(
    new URL("./plugin-defaults-contract.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    gatewayContract,
    CONFIG_FROM_DEFAULT_PATTERN,
    "the pinned-gateway schema check must start from Foundry's defaults",
  );
  assert.match(
    gatewayContract,
    RANDOM_ENCRYPTION_SECRET_PATTERN,
    "the pinned-gateway schema check must generate a 32-byte OIDC operator secret",
  );
  assert.match(
    gatewayContract,
    REQUIRED_INPUTS_ASSERTION_PATTERN,
    "the pinned-gateway schema check must verify no undeclared default changes",
  );
  assert.match(
    gatewayContract,
    VERIFIED_CONFIG_SUBMISSION_PATTERN,
    "the pinned-gateway schema check must submit the config it verified",
  );
});

test("Foundry's built-in plugin priorities equal the pinned plugin catalog", () => {
  const expected = Object.fromEntries(pluginCatalog.plugins
    .filter((plugin) => plugin.classification !== "reserved")
    .map((plugin) => [plugin.name, plugin.priority]));
  assert.deepEqual(
    { ...PLUGIN_PRIORITY },
    expected,
    "PLUGIN_PRIORITY must list every non-reserved catalog plugin with its catalog priority",
  );
});

test("provisioned-by usage follows the pinned vocabulary", () => {
  const labelKey = provisionedBy.label.key;
  const headerName = provisionedBy.header.name;
  const foundry = provisionedBy.values.find((entry) => entry.product === "Foundry");
  assert.ok(foundry, "provisioned-by contract must contain the Foundry product value");

  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const proxy = source("../server/proxy.ts");
  const labels = source("../src/components/shared/ResourceLabels.tsx");
  const mock = source("./mock-admin-gateway.mjs");

  assert.match(
    proxy,
    new RegExp(`['"]${headerName.toLowerCase()}['"]\\s*:\\s*['"]${foundry.value}['"]`),
    `server/proxy.ts must send ${headerName}: ${foundry.value}`,
  );
  assert.ok(labels.includes(`key === "${labelKey}"`),
    `ResourceLabels.tsx must recognize the ${labelKey} vocabulary label`);
  assert.match(mock, new RegExp(`PROVISIONED_BY_LABEL\\s*=\\s*['"]${labelKey}['"]`),
    `mock-admin-gateway.mjs must stamp the ${labelKey} vocabulary label`);
});
