/* ------------------------------------------------------------------ */
/*  Edge main early warning: the static drift checks                   */
/*  (ferrum-edge/ferrum-contracts#76)                                  */
/* ------------------------------------------------------------------ */

/**
 * The Pinned Gateway Contract job compares Foundry's transcriptions of Edge
 * sources with the pinned Edge release: the guided plugin schema components
 * of `openapi.yaml` (`plugin-schema-drift.mjs`), the plugin configuration
 * projection table (`plugin-sensitivity-drift.mjs`) and the server-owned
 * subset `traffic_policy` fields, the `readOnly` properties of
 * `SubsetTrafficPolicy` in `openapi.yaml`
 * (`subset-traffic-policy-drift.mjs`). The scheduled Edge Main
 * Drift workflow (`.github/workflows/edge-main-drift.yml`) runs the same
 * comparisons against an Edge `main` commit, so a change that has landed on
 * Edge `main` but is not released yet shows up before Foundry re-pins.
 *
 * It also compares the plugin trigger predicate lists Foundry redacts by
 * (`TRIGGER_CLIENT_FIELD_PREDICATES` and `TRIGGER_VISIBLE_PREDICATES` in
 * `src/lib/resourceBaseline.ts`) with the same constants of Edge main's
 * projection source. The pinned v0.9.20 has no trigger projection, so this
 * comparison has no pinned counterpart; Foundry redacts the client-field
 * operands on every gateway.
 *
 * Only the content comparisons apply here. The pinned checks also fail when
 * the recorded ref (`PLUGIN_SCHEMA_SPEC.ref`, `PLUGIN_SENSITIVITY_SOURCE.commit`,
 * `SUBSET_TRAFFIC_POLICY_SOURCE.commit`) is not the checked commit; against
 * `main` that is always the case and says nothing about compatibility, so it
 * is not reported.
 *
 *   node scripts/edge-main-drift.mjs <40-hex Edge commit>
 *
 * Exit status: 0 when nothing drifted, 1 when something did, 2 when the check
 * could not run (a source that could not be fetched, a bad argument). A
 * fetched projection table or `SubsetTrafficPolicy` schema the parser cannot
 * read is drift, as is a trigger predicate constant that is missing or not a
 * plain string list: the parsers fail closed on any shape Foundry has not
 * transcribed. With FERRUM_EDGE_MAIN_DETAILS_PATH set, a Markdown list of the
 * findings is written there for the workflow's tracking issue.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PLUGIN_SCHEMA_PROVENANCE, PLUGIN_SCHEMA_SPEC } from "../src/lib/pluginSchemas.ts";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";
import {
  TRIGGER_CLIENT_FIELD_PREDICATES,
  TRIGGER_VISIBLE_PREDICATES,
} from "../src/lib/resourceBaseline.ts";
import {
  SUBSET_TRAFFIC_POLICY_SERVER_OWNED,
  SUBSET_TRAFFIC_POLICY_SOURCE,
} from "../src/api/subsetTrafficPolicy.ts";
import { compareProvenance } from "./plugin-schema-drift.mjs";
import {
  compareSensitivity,
  foundryTables,
  parseKafkaSafeProperties,
  parseSensitivitySchemas,
  parseStringSliceConstant,
} from "./plugin-sensitivity-drift.mjs";
import { fetchPinnedSource } from "./pinned-source.mjs";
import {
  compareServerOwned,
  parseServerOwnedSubsetFields,
} from "./subset-traffic-policy-drift.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Foundry's copies of Edge main's trigger predicate lists, by Edge's constant name. */
export const FOUNDRY_TRIGGER_PREDICATES = {
  TRIGGER_CLIENT_FIELD_PREDICATES,
  TRIGGER_VISIBLE_PREDICATES,
};

/**
 * Each trigger predicate list of `projection` against Foundry's copy: the
 * predicates Edge lists and Foundry does not (`missing`), the reverse
 * (`extra`), or a constant the parser cannot read (`unreadable`). Order does
 * not matter; both are sets.
 */
export function compareTriggerPredicates(projection, foundry = FOUNDRY_TRIGGER_PREDICATES) {
  const findings = [];
  for (const [constant, ours] of Object.entries(foundry)) {
    let theirs;
    try {
      theirs = parseStringSliceConstant(projection, constant);
    } catch (error) {
      findings.push({
        constant,
        status: "unreadable",
        predicates: [],
        reason: String(error?.message ?? error),
      });
      continue;
    }
    const missing = theirs.filter((predicate) => !ours.includes(predicate));
    const extra = ours.filter((predicate) => !theirs.includes(predicate));
    if (missing.length > 0) findings.push({ constant, status: "missing", predicates: missing });
    if (extra.length > 0) findings.push({ constant, status: "extra", predicates: extra });
  }
  return findings;
}

/**
 * Every content difference between Foundry's transcriptions and the Edge
 * sources `spec` (`openapi.yaml`) and `projection`
 * (`plugin_config_projection.rs`) read at one Edge commit.
 */
export function edgeMainDrift(
  spec,
  projection,
  {
    provenance = PLUGIN_SCHEMA_PROVENANCE,
    foundry = foundryTables(),
    serverOwned = SUBSET_TRAFFIC_POLICY_SERVER_OWNED,
    triggerPredicates = FOUNDRY_TRIGGER_PREDICATES,
  } = {},
) {
  const schemas = compareProvenance(spec, provenance).filter(
    (finding) => finding.status !== "unchanged",
  );
  let sensitivity;
  try {
    sensitivity = compareSensitivity(
      {
        schemas: parseSensitivitySchemas(projection),
        kafka: parseKafkaSafeProperties(projection),
      },
      foundry,
    );
  } catch (error) {
    // The parser refuses any shape Foundry has not transcribed (a new
    // FieldSensitivity, rule constructor or literal form). Against a fetched
    // Edge source that is a change Foundry must adopt, so it is a finding.
    sensitivity = [
      {
        plugin: "PLUGIN_SENSITIVITY_SCHEMAS",
        status: "unreadable",
        reason: String(error?.message ?? error),
      },
    ];
  }
  let subset;
  try {
    subset = compareServerOwned(parseServerOwnedSubsetFields(spec), serverOwned);
  } catch (error) {
    // As above: a SubsetTrafficPolicy shape the parser refuses is a change.
    subset = [{ status: "unreadable", fields: [], reason: String(error?.message ?? error) }];
  }
  const trigger = compareTriggerPredicates(projection, triggerPredicates);
  return {
    schemas,
    sensitivity,
    subset,
    trigger,
    drifted:
      schemas.length > 0 || sensitivity.length > 0 || subset.length > 0 || trigger.length > 0,
  };
}

/** The findings as a Markdown list, or a single line saying there are none. */
export function driftMarkdown({ schemas, sensitivity, subset, trigger }) {
  if (
    schemas.length === 0 &&
    sensitivity.length === 0 &&
    subset.length === 0 &&
    trigger.length === 0
  ) {
    return (
      "- Guided plugin schemas, the plugin sensitivity table, the server-owned " +
      "subset traffic_policy fields and the plugin trigger predicate lists match.\n"
    );
  }
  const lines = [];
  for (const finding of schemas) {
    lines.push(
      `- \`${PLUGIN_SCHEMA_SPEC.path}\` component \`${finding.component}\`: ${finding.status}` +
        " (re-review the guided descriptors in `src/lib/pluginSchemas.ts`)",
    );
  }
  for (const finding of sensitivity) {
    lines.push(
      `- \`${PLUGIN_SENSITIVITY_SOURCE.path}\` entry \`${finding.plugin}\`: ${finding.status}` +
        (finding.reason ? ` (${finding.reason})` : "") +
        " (bring `src/api/pluginSensitivity.ts` in line)",
    );
  }
  for (const finding of subset) {
    lines.push(
      `- \`${SUBSET_TRAFFIC_POLICY_SOURCE.path}\` component ` +
        `\`${SUBSET_TRAFFIC_POLICY_SOURCE.component}\` readOnly fields: ${finding.status}` +
        (finding.fields.length > 0 ? ` \`${finding.fields.join("`, `")}\`` : "") +
        (finding.reason ? ` (${finding.reason})` : "") +
        " (bring `SUBSET_TRAFFIC_POLICY_SERVER_OWNED` in `src/api/subsetTrafficPolicy.ts` in line)",
    );
  }
  for (const finding of trigger) {
    lines.push(
      `- \`${PLUGIN_SENSITIVITY_SOURCE.path}\` constant \`${finding.constant}\`: ${finding.status}` +
        (finding.predicates.length > 0 ? ` \`${finding.predicates.join("`, `")}\`` : "") +
        (finding.reason ? ` (${finding.reason})` : "") +
        " (bring the trigger predicate lists in `src/lib/resourceBaseline.ts` in line)",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Fetch both Edge sources at `ref` and compare them. */
export async function edgeMainDriftAt(ref, { fetchSource = fetchPinnedSource } = {}) {
  if (!COMMIT_PATTERN.test(ref ?? "")) {
    throw new Error(`expected a 40-hex Edge commit, got ${JSON.stringify(ref)}`);
  }
  const [spec, projection] = await Promise.all([
    fetchSource(PLUGIN_SCHEMA_SPEC, ref),
    fetchSource(PLUGIN_SENSITIVITY_SOURCE, ref),
  ]);
  return edgeMainDrift(spec, projection);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const ref = process.argv[2];
  let result;
  try {
    result = await edgeMainDriftAt(ref);
  } catch (error) {
    console.error(`The Edge main static checks could not run: ${error?.message ?? error}`);
    process.exit(2);
  }
  const { schemas, sensitivity, subset, trigger, drifted } = result;
  console.log(JSON.stringify({ ref, schemas, sensitivity, subset, trigger }, null, 2));
  const detailsPath = process.env.FERRUM_EDGE_MAIN_DETAILS_PATH;
  if (detailsPath) writeFileSync(detailsPath, driftMarkdown(result));
  if (drifted) {
    console.error(
      `\nFoundry's transcriptions differ from Ferrum Edge at ${ref}:\n${driftMarkdown(result)}` +
        "This is an early warning: the change is on Edge main and not released yet.",
    );
    process.exit(1);
  }
}
