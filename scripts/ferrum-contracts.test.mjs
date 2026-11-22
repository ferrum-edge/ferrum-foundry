import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseContractsPin } from "./contracts-pin.mjs";
import {
  DEFAULT_PLUGIN_CONFIGS,
  PLUGIN_METADATA,
  PLUGIN_PRIORITY,
} from "../src/lib/pluginConfigDefaults.ts";

const PIN_LINE_ERROR_PATTERN = /^PIN line \d+: /;
const PIN_FORMAT_ERROR_PATTERN = /^PIN /;
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

const pin = parseContractsPin(pinText);
const contractDir = fileURLToPath(contractRoot);

function pinnedFiles() {
  return pin.files;
}

/**
 * Every vendored path relative to the contracts root, refusing any entry that
 * is neither a regular file nor a directory (consumer-pins.md check 4).
 */
function vendoredFiles() {
  const files = [];
  for (const entry of readdirSync(contractRoot, { recursive: true, withFileTypes: true })) {
    const path = relative(contractDir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isDirectory()) continue;
    assert.ok(entry.isFile(), `${path} is neither a regular file nor a directory`);
    if (path !== "PIN") files.push(path);
  }
  return files.sort();
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
  // contracts-edge-0.9.21 keeps the same 82 plugins, priorities, and
  // provisioned-by values as v0.9.20 while shipping the service-manifest v1
  // #74/#82 updates (#723); allow v0.9.20 until the Edge v0.9.21 pin (#748)
  // lands.
  "contracts-edge-0.9.21": ["v0.9.20", "v0.9.21"],
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
  const files = pinnedFiles();
  assert.equal(files.size, 37,
    "PIN must include the reviewed vocabularies, schema, fixtures and invalid expectations");
  assert.deepEqual([...files.keys()].sort(), vendoredFiles(), "PIN must cover every vendored file");
  for (const [path, expected] of files) {
    const contents = readFileSync(new URL(path, contractRoot));
    const actual = createHash("sha256").update(contents).digest("hex");
    assert.equal(actual, expected, `${path} differs from its Ferrum Contracts PIN digest`);
  }
});

test("the contracts pin tracks the qualified Ferrum Edge release", () => {
  const { tag, edgeVersion: pinnedEdgeVersion } = pin;
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
  if (pinnedEdgeVersion !== undefined) {
    assert.equal(pinnedEdgeVersion, edgeVersion, "PIN edge_version must be the qualified Edge release");
  }
});

/* ---------------- PIN format (ferrum-contracts docs/consumer-pins.md) ---------------- */

const SAMPLE_HASH_A = "a".repeat(64);
const SAMPLE_HASH_B = "b".repeat(64);
const SAMPLE_HEADERS = [
  "tag contracts-edge-0.9.20",
  "commit 39da322083044c2e92617209e62983c92387f0ad",
];

function samplePin(lines) {
  return `${lines.join("\n")}\n`;
}

test("the PIN parser accepts the canonical format, with or without edge_version", () => {
  const rows = [`${SAMPLE_HASH_A}  a-b/x.json`, `${SAMPLE_HASH_B}  a/x.json`];
  const parsed = parseContractsPin(samplePin([...SAMPLE_HEADERS, ...rows]));
  assert.equal(parsed.tag, "contracts-edge-0.9.20");
  assert.equal(parsed.commit, "39da322083044c2e92617209e62983c92387f0ad");
  assert.equal(parsed.edgeVersion, undefined);
  assert.deepEqual([...parsed.files], [["a-b/x.json", SAMPLE_HASH_A], ["a/x.json", SAMPLE_HASH_B]]);

  const withEdge = parseContractsPin(samplePin([...SAMPLE_HEADERS, "edge_version v0.9.20", ...rows]));
  assert.equal(withEdge.edgeVersion, "v0.9.20");
  assert.equal(parseContractsPin(samplePin(["tag contracts-edge-0.9.9-r2", SAMPLE_HEADERS[1], rows[0]])).tag,
    "contracts-edge-0.9.9-r2");
});

test("the PIN parser refuses every line that does not match its position", () => {
  const row = `${SAMPLE_HASH_A}  vocabularies/a.json`;
  const lineCases = {
    "legacy tag= header": ["tag=contracts-edge-0.9.20", SAMPLE_HEADERS[1], row],
    "legacy commit= header": [SAMPLE_HEADERS[0], "commit=39da322083044c2e92617209e62983c92387f0ad", row],
    "headers out of order": [SAMPLE_HEADERS[1], SAMPLE_HEADERS[0], row],
    "revision -r1": ["tag contracts-edge-0.9.20-r1", SAMPLE_HEADERS[1], row],
    "short commit": [SAMPLE_HEADERS[0], "commit 39da3220", row],
    "repeated tag": [...SAMPLE_HEADERS, "tag contracts-edge-0.9.20", row],
    "repeated edge_version": [...SAMPLE_HEADERS, "edge_version v0.9.20", "edge_version v0.9.20", row],
    "misplaced edge_version": [...SAMPLE_HEADERS, row, "edge_version v0.9.20"],
    "legacy sha256 row prefix": [...SAMPLE_HEADERS, `sha256  ${SAMPLE_HASH_A}  vocabularies/a.json`],
    "one space": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A} vocabularies/a.json`],
    "three spaces": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}   vocabularies/a.json`],
    "uppercase hash": [...SAMPLE_HEADERS, `${"A".repeat(64)}  vocabularies/a.json`],
    "short hash": [...SAMPLE_HEADERS, `${"a".repeat(63)}  vocabularies/a.json`],
    "unknown key": [...SAMPLE_HEADERS, "source ferrum-contracts", row],
    "comment": [...SAMPLE_HEADERS, "# vocabularies", row],
    "blank line": [...SAMPLE_HEADERS, "", row],
    "trailing space": [...SAMPLE_HEADERS, `${row} `],
    "leading slash": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  /vocabularies/a.json`],
    "trailing slash": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  vocabularies/`],
    "empty segment": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  vocabularies//a.json`],
    "dot-dot segment": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  vocabularies/../a.json`],
    "dot segment": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  ./a.json`],
    "lists itself": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  PIN`],
    "unsorted rows": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  vocabularies/b.json`, row],
    "component-wise order": [...SAMPLE_HEADERS, `${SAMPLE_HASH_A}  a/x.json`, `${SAMPLE_HASH_B}  a-b/x.json`],
    "duplicate row": [...SAMPLE_HEADERS, row, `${SAMPLE_HASH_B}  vocabularies/a.json`],
  };
  for (const [label, lines] of Object.entries(lineCases)) {
    assert.throws(() => parseContractsPin(samplePin(lines)), { message: PIN_LINE_ERROR_PATTERN }, label);
  }

  const textCases = {
    "no rows": samplePin(SAMPLE_HEADERS),
    "empty": "",
    "CRLF line endings": `${[...SAMPLE_HEADERS, row].join("\r\n")}\r\n`,
    "no final newline": [...SAMPLE_HEADERS, row].join("\n"),
    "byte order mark": `\uFEFF${samplePin([...SAMPLE_HEADERS, row])}`,
  };
  for (const [label, text] of Object.entries(textCases)) {
    assert.throws(() => parseContractsPin(text), { message: PIN_FORMAT_ERROR_PATTERN }, label);
  }
});

test("the published manifest pin retains owner status and complete canonical integrity", () => {
  assert.equal(pin.tag, "contracts-edge-0.9.21");
  assert.equal(pin.commit, "92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f");
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
    "21f83f6c3572dde3b5406b63ea74952ca564b37aa1fcf2ee4742e8a9e94e46e6");
  assert.equal(pinnedFiles().get("vocabularies/plugin-catalog.json"),
    "0b5890162e0510f8eb6e7968fa584278e8f58ffe5695f61420f7ff4b992ea8e1");
  assert.equal(pinnedFiles().get("vocabularies/provisioned-by.json"),
    "2640f3b8bb26632a55b8414dd7f73d3e38cf124addb8aad6c3d9620a9648f53e");
  assert.equal(pinnedFiles().get("fixtures/invalid-expectations.json"),
    "38310950957a208c4f4986d1d3f8c4a7ff80ccdfd66950dcb0cefdcb882721aa");
});

test("the vocabularies bind the published Edge source without changing attribution semantics", () => {
  const compatibility = JSON.parse(
    readFileSync(new URL("../docs/compatibility.json", import.meta.url), "utf8"),
  );
  // While docs/compatibility.json still pins v0.9.20 ahead of #748, the
  // re-vendored contracts-edge-0.9.21 vocabularies bind published Edge v0.9.21;
  // once compatibility.edge.release.version matches, bind it directly.
  const contractsEdgeSource =
    pluginCatalog.edge_release === compatibility.edge.release.version
      ? {
          version: compatibility.edge.release.version,
          commit: compatibility.edge.source_commit,
          openapiSha256: compatibility.edge.release.openapi.sha256,
        }
      : {
          version: "v0.9.21",
          commit: "f9915358c8032214f4034a17c28cdf72d14006c3",
          openapiSha256: "13c21d12d3028c8044ad2f467cbca6425d9bd2f3fce787d6fe7ae78316c21bee",
        };
  for (const vocabulary of [pluginCatalog, provisionedBy]) {
    assert.equal(vocabulary.edge_release, contractsEdgeSource.version);
    for (const source of vocabulary.provenance) {
      assert.equal(source.repo, "ferrum-edge/ferrum-edge");
      assert.equal(source.ref, contractsEdgeSource.version);
      assert.equal(source.commit, contractsEdgeSource.commit);
    }
    assert.equal(Object.hasOwn(vocabulary, "main_branch_delta"), false);
  }
  assert.equal(pluginCatalog.config_schema_document.commit, contractsEdgeSource.commit);
  assert.equal(pluginCatalog.config_schema_document.sha256, contractsEdgeSource.openapiSha256);
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
