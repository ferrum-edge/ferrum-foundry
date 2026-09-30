import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  assert.match(pinText, /^tag=contracts-edge-[0-9.]+$/m);
  assert.match(pinText, /^commit=[a-f0-9]{40}$/m);
  const files = pinnedFiles();
  assert.equal(files.size, 4, "PIN must list every vendored contract file exactly once");
  for (const [path, expected] of files) {
    const contents = readFileSync(new URL(path, contractRoot));
    const actual = createHash("sha256").update(contents).digest("hex");
    assert.equal(actual, expected, `${path} differs from its Ferrum Contracts PIN digest`);
  }
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

  // The Pinned Gateway Contract job submits these same defaults unchanged with
  // enabled: true, so Edge validates each config against its pointed schema.
  const gatewayContract = readFileSync(
    new URL("./plugin-defaults-contract.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    gatewayContract,
    /config:\s*getPluginConfigDefault\(name\)/,
    "the pinned-gateway schema check must submit Foundry's defaults unchanged");
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
