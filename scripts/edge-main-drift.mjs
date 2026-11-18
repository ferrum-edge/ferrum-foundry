/* ------------------------------------------------------------------ */
/*  Edge main early warning: the static drift checks                   */
/*  (ferrum-edge/ferrum-contracts#76)                                  */
/* ------------------------------------------------------------------ */

/**
 * The Pinned Gateway Contract job compares Foundry's transcriptions of Edge
 * sources with the pinned Edge release: the guided plugin schema components
 * of `openapi.yaml` (`plugin-schema-drift.mjs`) and the plugin configuration
 * projection table (`plugin-sensitivity-drift.mjs`). The scheduled Edge Main
 * Drift workflow (`.github/workflows/edge-main-drift.yml`) runs the same
 * comparisons against an Edge `main` commit, so a change that has landed on
 * Edge `main` but is not released yet shows up before Foundry re-pins.
 *
 * Only the content comparisons apply here. The pinned checks also fail when
 * the recorded ref (`PLUGIN_SCHEMA_SPEC.ref`, `PLUGIN_SENSITIVITY_SOURCE.commit`)
 * is not the checked commit; against `main` that is always the case and says
 * nothing about compatibility, so it is not reported.
 *
 *   node scripts/edge-main-drift.mjs <40-hex Edge commit>
 *
 * Exit status: 0 when nothing drifted, 1 when something did, 2 when the check
 * could not run (a source that could not be fetched, a bad argument). A
 * fetched projection table the parser cannot read is drift: its parser fails
 * closed on any shape Foundry has not transcribed. With
 * FERRUM_EDGE_MAIN_DETAILS_PATH set, a Markdown list of the findings is
 * written there for the workflow's tracking issue.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PLUGIN_SCHEMA_PROVENANCE, PLUGIN_SCHEMA_SPEC } from "../src/lib/pluginSchemas.ts";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";
import { compareProvenance } from "./plugin-schema-drift.mjs";
import {
  compareSensitivity,
  foundryTables,
  parseKafkaSafeProperties,
  parseSensitivitySchemas,
} from "./plugin-sensitivity-drift.mjs";
import { fetchPinnedSource } from "./pinned-source.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Every content difference between Foundry's transcriptions and the Edge
 * sources `spec` (`openapi.yaml`) and `projection`
 * (`plugin_config_projection.rs`) read at one Edge commit.
 */
export function edgeMainDrift(
  spec,
  projection,
  { provenance = PLUGIN_SCHEMA_PROVENANCE, foundry = foundryTables() } = {},
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
  return { schemas, sensitivity, drifted: schemas.length > 0 || sensitivity.length > 0 };
}

/** The findings as a Markdown list, or a single line saying there are none. */
export function driftMarkdown({ schemas, sensitivity }) {
  if (schemas.length === 0 && sensitivity.length === 0) {
    return "- Guided plugin schemas and the plugin sensitivity table match.\n";
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
  const { schemas, sensitivity, drifted } = result;
  console.log(JSON.stringify({ ref, schemas, sensitivity }, null, 2));
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
