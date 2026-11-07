/* ------------------------------------------------------------------ */
/*  Guided plugin schema drift check (issue #383)                      */
/* ------------------------------------------------------------------ */

/**
 * `src/lib/pluginSchemas.ts` holds a reviewed reduction of named schema
 * components from the canonical Ferrum Edge `openapi.yaml`, together with the
 * SHA-256 of each source block. Foundry deliberately keeps no copy of the
 * spec (CLAUDE.md), so the digest is what pins the provenance: it is the proof
 * of what the descriptors were reviewed against.
 *
 * This re-fetches the spec at the pinned Edge source and compares. A changed
 * block fails the check —
 * loudly, naming the component — because a guided field set derived from an
 * older schema is exactly how a structured editor starts stripping fields a
 * newer gateway understands.
 *
 *   node scripts/plugin-schema-drift.mjs              # pinned Edge source
 *   FERRUM_SPEC_REF=main node scripts/plugin-schema-drift.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  PLUGIN_SCHEMA_PROVENANCE,
  PLUGIN_SCHEMA_SPEC,
} from "../src/lib/pluginSchemas.ts";
import { fetchPinnedSource } from "./pinned-source.mjs";

const SCHEMA_COMPONENT_KEY_PATTERN = /^ {4}[A-Za-z0-9_]+:/;

/**
 * Extract one `components.schemas.<name>` block from an OpenAPI document.
 *
 * Components sit at four-space indentation, so a block runs from its own key
 * line to the next key at that indentation. Trailing blank lines are dropped
 * so a cosmetic change in the *following* component cannot register as drift
 * in this one. This is the definition the pinned digests were computed with;
 * change it and every digest has to be recomputed.
 */
export function extractSchemaBlock(spec, component) {
  const lines = spec.split("\n");
  const start = lines.indexOf(`    ${component}:`);
  if (start === -1) return null;

  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SCHEMA_COMPONENT_KEY_PATTERN.test(lines[index])) break;
    block.push(lines[index]);
  }
  while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
  return block.join("\n");
}

export function digestOf(block) {
  return createHash("sha256").update(block, "utf8").digest("hex");
}

/** Compare every pinned component against `spec`. Returns the findings. */
export function compareProvenance(spec, provenance = PLUGIN_SCHEMA_PROVENANCE) {
  return provenance.map((entry) => {
    const block = extractSchemaBlock(spec, entry.component);
    if (block === null) {
      return { ...entry, status: "missing", actual: null };
    }
    const actual = digestOf(block);
    return {
      ...entry,
      status: actual === entry.sha256 ? "unchanged" : "changed",
      actual,
    };
  });
}

/** Exact fetched source blocks and hashes for a hosted, serial pin review. */
export function schemaProducerExport(spec, ref) {
  return {
    record_version: 1,
    source: {
      repository: PLUGIN_SCHEMA_SPEC.repository,
      path: PLUGIN_SCHEMA_SPEC.path,
      ref,
      sha256: digestOf(spec),
    },
    reviewed_ref: PLUGIN_SCHEMA_SPEC.ref,
    components: compareProvenance(spec).map((finding) => ({
      ...finding,
      yaml: extractSchemaBlock(spec, finding.component),
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pairing = JSON.parse(
    readFileSync(new URL("../docs/compatibility.json", import.meta.url), "utf8"),
  );
  const ref = process.env.FERRUM_SPEC_REF?.trim() || pairing.edge.source_commit;
  const spec = await fetchPinnedSource(PLUGIN_SCHEMA_SPEC, ref);
  const findings = compareProvenance(spec);
  const drifted = findings.filter((finding) => finding.status !== "unchanged");

  const exportPath = process.env.FERRUM_SCHEMA_EXPORT_PATH;
  if (exportPath) {
    writeFileSync(exportPath, `${JSON.stringify(schemaProducerExport(spec, ref), null, 2)}\n`, {
      flag: "wx",
    });
  }
  console.log(JSON.stringify({ ref, findings }, null, 2));

  if (drifted.length > 0) {
    console.error(
      "\nGuided plugin schemas have drifted from the upstream spec:\n" +
        drifted
          .map(
            (finding) =>
              `  ${finding.component}: ${finding.status}` +
              (finding.actual ? ` (now ${finding.actual})` : ""),
          )
          .join("\n") +
        "\n\nRe-review the affected descriptors in src/lib/pluginSchemas.ts, then " +
        "update PLUGIN_SCHEMA_PROVENANCE and PLUGIN_SCHEMA_SPEC.ref together. " +
        "Do not update the digest without re-reading the schema: the digest is " +
        "the only record of what the field set was checked against.",
    );
    process.exit(1);
  }
}
