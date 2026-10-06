import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_PLUGIN_CONFIGS,
  PLUGIN_METADATA,
} from "../src/lib/pluginConfigDefaults.ts";

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
  for (const line of pinText.split(/\r?\n/)) {
    const match = /^sha256\s+([a-f0-9]{64})\s+(.+)$/.exec(line);
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
  assert.match(pinText, /^tag=contracts-edge-[0-9.]+(?:-r[1-9][0-9]*)?$/m);
  assert.match(pinText, /^commit=[a-f0-9]{40}$/m);
  const files = pinnedFiles();
  const actualFiles = readdirSync(contractRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "PIN")
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(contractRoot.pathname.length))
    .sort();
  assert.equal(files.size, 18,
    "PIN must include the reviewed vocabularies, schema, fixtures and invalid expectations");
  assert.deepEqual([...files.keys()].sort(), actualFiles, "PIN must cover every vendored file");
  assert.equal(pinText.split(/\r?\n/).filter((line) => line.startsWith("sha256")).length,
    files.size, "PIN must not contain duplicate entries");
  for (const [path, expected] of files) {
    const contents = readFileSync(new URL(path, contractRoot));
    const actual = createHash("sha256").update(contents).digest("hex");
    assert.equal(actual, expected, `${path} differs from its Ferrum Contracts PIN digest`);
  }
});

test("the contracts pin tracks the qualified Ferrum Edge release", () => {
  const tag = /^tag=(contracts-edge-[0-9.]+(?:-r[1-9][0-9]*)?)$/m.exec(pinText)?.[1];
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
  assert.match(pinText, /^tag=contracts-edge-0\.9\.13$/m);
  assert.match(pinText, /^commit=9626821eb089c71f5d4d71268c7b8276a8a5ab50$/m);
  const schema = JSON.parse(readFileSync(
    new URL("schemas/service-manifest/v1.schema.json", contractRoot), "utf8",
  ));
  assert.equal(schema["x-contract"].status, "implemented");
  assert.match(schema["x-contract"].shared_status, /^EXISTING shared v1/);
  assert.equal(schema["x-contract"].owner, "ferrum-edge/ferrum-alloy");
  assert.equal(schema["x-contract"].provenance[0].commit,
    "81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e");
  assert.equal(schema["x-contract"].provenance[0].availability, "unreleased");
  assert.equal(schema["x-contract"].coordinated_release.qualified_owner_commit,
    "81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e");
  assert.equal(pinnedFiles().get("schemas/service-manifest/v1.schema.json"),
    "3d086aec773345df3547adf6e026ad466168b27bf98163614d44171b7862b5dc");
  assert.equal(pinnedFiles().get("vocabularies/plugin-catalog.json"),
    "be31cc53508042c6efd0e745e8c673fb66bbbdb1d2dd1a2eaa1a813f09ae80c3");
  assert.equal(pinnedFiles().get("vocabularies/provisioned-by.json"),
    "514913de70c0caf3b5092363fb34d11c46da3f9ff9d0c98b0a83bfe2e04c76c9");
  assert.equal(pinnedFiles().get("fixtures/invalid-expectations.json"),
    "048ded8e16600e116bcfb3cf6eaae4c00aca49a9061395c8cc647e1f66191699");
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
      /^#\/components\/schemas\/[A-Za-z0-9]+$/,
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
    /const config = getPluginConfigDefault\(name\);/,
    "the pinned-gateway schema check must start from Foundry's defaults",
  );
  assert.match(
    gatewayContract,
    /config\.session\.encryption_secret = randomBytes\(32\)\.toString\("base64"\);/,
    "the pinned-gateway schema check must generate a 32-byte OIDC operator secret",
  );
  assert.match(
    gatewayContract,
    /assertOnlyRequiredOperatorInputs\(name, config\);/,
    "the pinned-gateway schema check must verify no undeclared default changes",
  );
  assert.match(
    gatewayContract,
    /config,\s*\},\s*\}\);/,
    "the pinned-gateway schema check must submit the config it verified",
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
