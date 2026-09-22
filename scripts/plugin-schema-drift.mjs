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
 * This re-fetches the spec and compares. A changed block fails the check —
 * loudly, naming the component — because a guided field set derived from an
 * older schema is exactly how a structured editor starts stripping fields a
 * newer gateway understands.
 *
 *   node scripts/plugin-schema-drift.mjs              # pinned revision
 *   FERRUM_SPEC_REF=main node scripts/plugin-schema-drift.mjs
 */

import { createHash } from "node:crypto";
import {
  PLUGIN_SCHEMA_PROVENANCE,
  PLUGIN_SCHEMA_SPEC,
} from "../src/lib/pluginSchemas.ts";

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
    if (/^ {4}[A-Za-z0-9_]+:/.test(lines[index])) break;
    block.push(lines[index]);
  }
  while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
  return block.join("\n");
}

export function digestOf(block) {
  return createHash("sha256").update(block, "utf8").digest("hex");
}

const TRANSPORT_FAILURE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i;

async function fetchSpec(ref) {
  const url =
    `https://raw.githubusercontent.com/${PLUGIN_SCHEMA_SPEC.repository}/` +
    `${ref}/${PLUGIN_SCHEMA_SPEC.path}`;

  // A registry outage must not be reported as schema drift, and it must not
  // pass either. Transport failures are retried; an HTTP error is fatal.
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (!TRANSPORT_FAILURE.test(String(error?.message ?? error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error(`Could not fetch ${url}: ${lastError?.message ?? "unknown error"}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.env.FERRUM_SPEC_REF?.trim() || PLUGIN_SCHEMA_SPEC.ref;
  const spec = await fetchSpec(ref);
  const findings = compareProvenance(spec);
  const drifted = findings.filter((finding) => finding.status !== "unchanged");

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
