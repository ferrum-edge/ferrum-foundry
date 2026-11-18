import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkServerOwned,
  compareServerOwned,
  parseServerOwnedSubsetFields,
} from "./subset-traffic-policy-drift.mjs";
import { MESH_PROJECTED_SUBSET_POLICY_FIELDS } from "./mock-admin-gateway.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";
import {
  SUBSET_TRAFFIC_POLICY_SERVER_OWNED,
  SUBSET_TRAFFIC_POLICY_SOURCE,
} from "../src/api/subsetTrafficPolicy.ts";

const NOT_FOUND_PATTERN = /`SubsetTrafficPolicy` not found/;
const UNRECOGNISED_ALL_OF_PATTERN = /unrecognised `allOf:` in SubsetTrafficPolicy/;
const OBJECT_READ_ONLY_PATTERN = /unrecognised `readOnly: true` in SubsetTrafficPolicy/;
const NESTED_READ_ONLY_PATTERN = /`readOnly` nested inside `tls`/;
const READ_ONLY_VALUE_PATTERN = /`tls` has readOnly `yes`/;
const QUOTED_READ_ONLY_PATTERN = /unrecognised `"readOnly": true`/;
const FLOW_PROPERTY_PATTERN = /unrecognised property `max_retries: \{ type: integer \}`/;
const TWICE_PATTERN = /`tls` appears twice/;
const NO_PROPERTIES_PATTERN = /declares no `properties`/;
const MULTILINE_FLOW_PATTERN =
  /unrecognised `\{ type: integer, readOnly: true \}` in `new_projected_field`/;
const BRANCH_FLOW_MAPPING_PATTERN = /flow mapping `\{ type: string, readOnly: true \}` in `hash_on`/;
const KEYWORD_FLOW_MAPPING_PATTERN = /flow mapping `\{ readOnly: true \}` in `connect_timeout_ms`/;
const FLOW_SEQUENCE_PATTERN = /flow sequence `\[integer, \{ readOnly: true \}\]` in `connect_timeout_ms`/;
const UNEXPECTED_INDENTATION_PATTERN = /line \d+: unexpected indentation/;

/** Shaped like Edge's `openapi.yaml` around `SubsetTrafficPolicy`. */
const SPEC = [
  "components:",
  "  schemas:",
  "    SubsetDefinition:",
  "      type: object",
  "      properties:",
  "        traffic_policy:",
  "          readOnly: true",
  "    SubsetTrafficPolicy:",
  "      type: object",
  "      description: >-",
  "        Per-subset policy.",
  "        readOnly: true (prose, not a keyword)",
  "      properties:",
  "        load_balancer_algorithm:",
  "          oneOf:",
  '            - $ref: "#/components/schemas/LoadBalancerAlgorithm"',
  '            - type: "null"',
  "          description: |",
  "            Optional override.",
  "            readOnly: false is not a keyword here either",
  "        hash_on:",
  "          oneOf:",
  "            - type: string",
  '            - type: "null"',
  "        tls:",
  "          oneOf:",
  '            - $ref: "#/components/schemas/MeshTrafficPolicyTls"',
  '            - type: "null"',
  "          readOnly: true",
  "          description: >-",
  "            Projected from a mesh DestinationRule.",
  "        connect_timeout_ms:",
  '          type: [integer, "null"]',
  "          format: uint64",
  "          readOnly: true",
  "        max_retries:",
  '          type: [integer, "null"]',
  "          readOnly: false",
  "",
  "    TargetDefinition:",
  "      type: object",
  "",
].join("\n");

test("derives the readOnly properties of SubsetTrafficPolicy, skipping prose and other components", () => {
  assert.deepEqual(parseServerOwnedSubsetFields(SPEC), ["tls", "connect_timeout_ms"]);
});

test("the last component of schemas ends at the next section of the document", () => {
  const spec = `${SPEC.slice(0, SPEC.indexOf("    TargetDefinition:"))}  securitySchemes:\n    bearer:\n      readOnly: true\n`;
  assert.deepEqual(parseServerOwnedSubsetFields(spec), ["tls", "connect_timeout_ms"]);
});

test("a shape the parser does not understand fails instead of yielding a smaller set", () => {
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("    SubsetTrafficPolicy:", "    SubsetPolicy:")),
    NOT_FOUND_PATTERN,
  );
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("      type: object\n      description: >-", "      allOf:\n        - $ref: x\n      description: >-")),
    UNRECOGNISED_ALL_OF_PATTERN,
  );
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("      type: object\n      description: >-", "      readOnly: true\n      description: >-")),
    OBJECT_READ_ONLY_PATTERN,
  );
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace(
          '            - $ref: "#/components/schemas/MeshTrafficPolicyTls"',
          '            - $ref: "#/components/schemas/MeshTrafficPolicyTls"\n              readOnly: true',
        ),
      ),
    NESTED_READ_ONLY_PATTERN,
  );
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace('          readOnly: true\n          description: >-', '          readOnly: yes\n          description: >-'),
      ),
    READ_ONLY_VALUE_PATTERN,
  );
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace('          readOnly: true\n          description: >-', '          "readOnly": true\n          description: >-'),
      ),
    QUOTED_READ_ONLY_PATTERN,
  );
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace('        max_retries:\n          type: [integer, "null"]\n          readOnly: false', "        max_retries: { type: integer }"),
      ),
    FLOW_PROPERTY_PATTERN,
  );
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("        connect_timeout_ms:", "        tls:")),
    TWICE_PATTERN,
  );
  assert.throws(
    () => parseServerOwnedSubsetFields("components:\n  schemas:\n    SubsetTrafficPolicy:\n      type: object\n"),
    NO_PROPERTIES_PATTERN,
  );
});

test("a flow collection that could hide readOnly fails instead of reading the property as writable", () => {
  // sol F1: a flow mapping on the line after the property name is valid YAML
  // that the line parser cannot read, so it must not default to writable.
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace(
          "\n\n    TargetDefinition:",
          "\n        new_projected_field:\n          { type: integer, readOnly: true }\n\n    TargetDefinition:",
        ),
      ),
    MULTILINE_FLOW_PATTERN,
  );
  // A flow mapping inside a composition branch.
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace("            - type: string", "            - { type: string, readOnly: true }"),
      ),
    BRANCH_FLOW_MAPPING_PATTERN,
  );
  // A flow mapping as a keyword's value, and a flow sequence holding one.
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("          format: uint64", "          format: { readOnly: true }")),
    KEYWORD_FLOW_MAPPING_PATTERN,
  );
  assert.throws(
    () =>
      parseServerOwnedSubsetFields(
        SPEC.replace('          type: [integer, "null"]\n          format: uint64', "          type: [integer, { readOnly: true }]\n          format: uint64"),
      ),
    FLOW_SEQUENCE_PATTERN,
  );
  // A line between property and keyword indentation.
  assert.throws(
    () => parseServerOwnedSubsetFields(SPEC.replace("          format: uint64", "         format: uint64")),
    UNEXPECTED_INDENTATION_PATTERN,
  );
});

test("a field Edge adds to the set, or one Foundry lists that Edge accepts, is drift", () => {
  assert.deepEqual(compareServerOwned(["tls", "connect_timeout_ms"], ["connect_timeout_ms", "tls"]), []);
  assert.deepEqual(compareServerOwned(["tls", "connect_timeout_ms", "max_retries"], ["tls", "connect_timeout_ms"]), [
    { status: "missing", fields: ["max_retries"] },
  ]);
  assert.deepEqual(compareServerOwned(["tls"], ["tls", "hash_on", "tls"]), [
    { status: "extra", fields: ["hash_on"] },
    { status: "duplicate", fields: ["tls"] },
  ]);
});

test("the checked ref must be the one the list records", () => {
  const options = { foundry: ["tls", "connect_timeout_ms"], recorded: "a".repeat(40) };
  assert.equal(checkServerOwned(SPEC, "a".repeat(40), options).refMatches, true);
  const other = checkServerOwned(SPEC, "b".repeat(40), options);
  assert.equal(other.refMatches, false);
  assert.deepEqual(other.findings, []);
});

test("the list records the pinned Edge source, so moving the pin means re-reading the schema", () => {
  assert.equal(SUBSET_TRAFFIC_POLICY_SOURCE.commit, readSupportedPairing().edge.source_commit);
  assert.equal(SUBSET_TRAFFIC_POLICY_SOURCE.path, "openapi.yaml");
});

test("the mock gateway refuses exactly the fields the editor leaves out, from the same list", () => {
  assert.equal(MESH_PROJECTED_SUBSET_POLICY_FIELDS, SUBSET_TRAFFIC_POLICY_SERVER_OWNED);
  assert.ok(Object.isFrozen(SUBSET_TRAFFIC_POLICY_SERVER_OWNED));
  assert.deepEqual(compareServerOwned(SUBSET_TRAFFIC_POLICY_SERVER_OWNED, SUBSET_TRAFFIC_POLICY_SERVER_OWNED), []);
});
