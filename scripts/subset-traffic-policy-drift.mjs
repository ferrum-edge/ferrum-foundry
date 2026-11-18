/* ------------------------------------------------------------------ */
/*  Server-owned subset traffic_policy field drift check (issue #717)  */
/* ------------------------------------------------------------------ */

/**
 * `SUBSET_TRAFFIC_POLICY_SERVER_OWNED` (`src/api/subsetTrafficPolicy.ts`)
 * names the `subsets[].traffic_policy` fields Ferrum Edge projects from a mesh
 * DestinationRule and refuses on every operator write. The upstream editor
 * leaves them out of a save and the mock gateway refuses them, both from that
 * one list. A field Edge adds to it that Foundry does not know is sent back
 * on every save that read it, and Edge answers `400`; a field Foundry lists
 * that Edge accepts is silently dropped from saves.
 *
 * Edge declares the set as the `readOnly` properties of the
 * `SubsetTrafficPolicy` schema in `openapi.yaml`. This fetches that file at
 * the commit of the Edge image CI qualifies (`edge.source_commit` in
 * `docs/compatibility.json`), the same way the guided plugin schema check
 * does, derives the set, and fails when it differs from Foundry's list — or
 * when the list does not record that commit as the one it was checked
 * against, so moving the pin always means re-reading the schema.
 *
 *   node scripts/subset-traffic-policy-drift.mjs            # the pinned Edge
 *   FERRUM_EDGE_REF=main node scripts/subset-traffic-policy-drift.mjs
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  SUBSET_TRAFFIC_POLICY_SERVER_OWNED,
  SUBSET_TRAFFIC_POLICY_SOURCE,
} from "../src/api/subsetTrafficPolicy.ts";
import { extractSchemaBlock } from "./plugin-schema-drift.mjs";
import { fetchPinnedSource } from "./pinned-source.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";

const COMPONENT_KEY_PATTERN = /^ {6}([A-Za-z$][A-Za-z0-9_$-]*):(.*)$/;
const PROPERTY_KEY_PATTERN = /^ {8}([A-Za-z_][A-Za-z0-9_]*):\s*$/;
const PROPERTY_FIELD_PATTERN = /^ {10}([A-Za-z$][A-Za-z0-9_$-]*):\s*(.*?)\s*$/;
const READ_ONLY_PATTERN = /^\s*(?:-\s+)?["']?readOnly["']?\s*:/;
const BLOCK_SCALAR_PATTERN = /:\s*[|>][-+0-9]*\s*$/;
const INDENT_PATTERN = /^ */;

/**
 * The keys a `SubsetTrafficPolicy` schema may carry at its top level. Any
 * other (`allOf`, `$ref`, `readOnly` on the whole object, …) changes how the
 * properties are declared, so the parser refuses it rather than read past it.
 */
const COMPONENT_KEYS = new Set([
  "type",
  "description",
  "title",
  "properties",
  "additionalProperties",
  "required",
]);

function indentOf(line) {
  return INDENT_PATTERN.exec(line)[0].length;
}

/**
 * The names of the `readOnly: true` properties of `SubsetTrafficPolicy` in
 * `spec` (Edge's `openapi.yaml`), in declaration order.
 *
 * Edge writes the component in block style: properties at eight spaces, each
 * with its keywords at ten. A `readOnly` anywhere else (on the object, inside
 * a `oneOf` branch, deeper in a property), a value other than `true` or
 * `false`, a property written in flow style, a repeated property, or a
 * top-level key outside `COMPONENT_KEYS` throws, so the check fails rather
 * than derive a set from a shape it does not understand. Block-scalar text
 * (`description: >-`) is skipped, so prose cannot be read as a keyword.
 */
export function parseServerOwnedSubsetFields(
  spec,
  component = SUBSET_TRAFFIC_POLICY_SOURCE.component,
) {
  const block = extractSchemaBlock(spec, component);
  if (block === null) throw new Error(`\`${component}\` not found in the spec`);
  const lines = block.split("\n").slice(1);

  const properties = new Map();
  let sawProperties = false;
  let inProperties = false;
  let property = null;
  let scalarIndent = null;

  for (const [offset, line] of lines.entries()) {
    const where = `${component} line ${offset + 2}`;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (scalarIndent !== null) {
      if (indent > scalarIndent) continue;
      scalarIndent = null;
    }
    // The last component of `schemas` runs on to the next section of the
    // document; the component ends at the first line outside it.
    if (indent < 6) break;

    const componentKey = indent === 6 ? COMPONENT_KEY_PATTERN.exec(line) : null;
    if (indent === 6) {
      if (!componentKey || !COMPONENT_KEYS.has(componentKey[1])) {
        throw new Error(`${where}: unrecognised \`${line.trim()}\` in ${component}`);
      }
      if (componentKey[1] === "properties") {
        if (sawProperties) throw new Error(`${where}: \`properties\` appears twice`);
        if (componentKey[2].trim() !== "") {
          throw new Error(`${where}: \`properties\` is not a block mapping`);
        }
        sawProperties = true;
        inProperties = true;
      } else {
        inProperties = false;
      }
      property = null;
    } else if (!inProperties) {
      // Nested under a non-`properties` top-level key (`required` items, an
      // `additionalProperties` schema): only a `readOnly` there matters.
      if (READ_ONLY_PATTERN.test(line)) {
        throw new Error(`${where}: \`readOnly\` outside a property of ${component}`);
      }
    } else if (indent === 8) {
      const key = PROPERTY_KEY_PATTERN.exec(line);
      if (!key) throw new Error(`${where}: unrecognised property \`${line.trim()}\``);
      if (properties.has(key[1])) throw new Error(`${where}: \`${key[1]}\` appears twice`);
      property = key[1];
      properties.set(property, false);
    } else if (indent === 10 && property !== null) {
      const field = PROPERTY_FIELD_PATTERN.exec(line);
      if (field?.[1] === "readOnly") {
        if (field[2] !== "true" && field[2] !== "false") {
          throw new Error(`${where}: \`${property}\` has readOnly \`${field[2]}\``);
        }
        properties.set(property, field[2] === "true");
      } else if (READ_ONLY_PATTERN.test(line)) {
        throw new Error(`${where}: unrecognised \`${line.trim()}\``);
      }
    } else if (READ_ONLY_PATTERN.test(line)) {
      throw new Error(`${where}: \`readOnly\` nested inside \`${property ?? component}\``);
    } else if (indent === 10 || property === null) {
      throw new Error(`${where}: unexpected indentation`);
    }

    if (BLOCK_SCALAR_PATTERN.test(line)) scalarIndent = indent;
  }

  if (!sawProperties) throw new Error(`${component} declares no \`properties\``);
  return [...properties].filter(([, readOnly]) => readOnly).map(([name]) => name);
}

/**
 * Every difference between Edge's server-owned fields and Foundry's list:
 * fields Foundry would send back (`missing`), fields it would drop although
 * Edge accepts them (`extra`), and names Foundry lists twice (`duplicate`).
 */
export function compareServerOwned(edge, foundry = SUBSET_TRAFFIC_POLICY_SERVER_OWNED) {
  const ours = new Set(foundry);
  const theirs = new Set(edge);
  const findings = [];
  const missing = edge.filter((field) => !ours.has(field));
  const extra = foundry.filter((field) => !theirs.has(field));
  const duplicate = foundry.filter((field, index) => foundry.indexOf(field) !== index);
  if (missing.length > 0) findings.push({ status: "missing", fields: missing });
  if (extra.length > 0) findings.push({ status: "extra", fields: [...new Set(extra)] });
  if (duplicate.length > 0) findings.push({ status: "duplicate", fields: [...new Set(duplicate)] });
  return findings;
}

/**
 * The whole verdict for one checked `ref`: the derived fields, the findings,
 * and whether the commit Foundry's list records is the one checked.
 */
export function checkServerOwned(
  spec,
  ref,
  { foundry = SUBSET_TRAFFIC_POLICY_SERVER_OWNED, recorded = SUBSET_TRAFFIC_POLICY_SOURCE.commit } = {},
) {
  const edge = parseServerOwnedSubsetFields(spec);
  const findings = compareServerOwned(edge, foundry);
  return { edge, findings, recorded, refMatches: recorded === ref };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const pinned = readSupportedPairing().edge.source_commit;
  const ref = process.env.FERRUM_EDGE_REF?.trim() || pinned;
  const spec = await fetchPinnedSource(SUBSET_TRAFFIC_POLICY_SOURCE, ref);
  const { edge, findings, recorded, refMatches } = checkServerOwned(spec, ref);

  console.log(JSON.stringify({ ref, recorded, edge, findings }, null, 2));

  if (findings.length > 0 || !refMatches) {
    console.error(
      `\nSUBSET_TRAFFIC_POLICY_SERVER_OWNED does not match the readOnly properties of ` +
        `${SUBSET_TRAFFIC_POLICY_SOURCE.component} in ${SUBSET_TRAFFIC_POLICY_SOURCE.path} ` +
        `at ${ref}:\n` +
        findings.map((finding) => `  ${finding.status}: ${finding.fields.join(", ")}`).join("\n") +
        (refMatches
          ? ""
          : `\n  SUBSET_TRAFFIC_POLICY_SOURCE.commit is ${recorded}, not the checked Edge source ${ref}`) +
        "\n\nRe-read the schema (and Upstream::validate_operator_provided_fields) at that commit, " +
        "bring SUBSET_TRAFFIC_POLICY_SERVER_OWNED in src/api/subsetTrafficPolicy.ts in line " +
        "with it, then record the commit and release in SUBSET_TRAFFIC_POLICY_SOURCE. A missing " +
        "field makes every upstream save that read it fail with 400; an extra one is dropped " +
        "from saves although Edge accepts it.",
    );
    process.exit(1);
  }
}
