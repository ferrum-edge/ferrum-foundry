/* ------------------------------------------------------------------ */
/*  Edge source parity: chain order, namespace routes, metrics modes   */
/* ------------------------------------------------------------------ */

/**
 * Foundry decides three things from Ferrum Edge's source rather than from an
 * admin API answer, and each is transcribed with the commit it was read at:
 *
 * - the order Edge runs a proxy's plugins in, which effective policy needs to
 *   tell whether a Consumer is authenticated before another plugin can refuse
 *   it: `PLUGIN_DEFAULT_PRIORITY` (`src/lib/pluginChainOrder.ts`), from
 *   `BUILTIN_PLUGIN_PARITY_META` in `src/plugins/builtin_parity.rs`;
 * - which admin routes Edge lets an `ns`-claim token reach, which bounds the
 *   BFF's namespace route ceiling: `EDGE_NAMESPACE_SCOPED_KINDS` and the
 *   allowlist digest (`server/proxy-path.ts`), from
 *   `namespace_scoped_resource_kind`, `ceiling_global_route_is_allowed` and
 *   `ns_claim_global_route_is_allowed` in `src/admin/mod.rs`;
 * - which gateway modes answer `/admin/metrics` with placeholders, which the
 *   Metrics page and Dashboard hide: `METRICS_MODES` and
 *   `NO_PROXY_STATE_MODES` (`src/lib/adminMetricsReporting.ts`), from
 *   `ADMIN_METRICS_MODES` and `contract_fixtures` in `src/admin/metrics.rs`.
 *
 * This fetches the three files at `edge.source_commit` (or FERRUM_EDGE_REF),
 * parses them, and fails on any difference, or when a transcription does not
 * record the checked commit. The parsers fail closed: a shape they do not
 * understand is reported, never read past.
 *
 *   node scripts/edge-source-parity.mjs            # the pinned Edge
 *   FERRUM_EDGE_REF=main node scripts/edge-source-parity.mjs
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_CHAIN_ORDER_SOURCE,
  PLUGIN_DEFAULT_PRIORITY,
} from "../src/lib/pluginChainOrder.ts";
import {
  ADMIN_METRICS_SOURCE,
  METRICS_MODES,
  NO_PROXY_STATE_MODES,
} from "../src/lib/adminMetricsReporting.ts";
import {
  EDGE_NAMESPACE_ROUTE_SOURCE,
  EDGE_NAMESPACE_SCOPED_KINDS,
} from "../server/proxy-path.ts";
import { fetchPinnedSource } from "./pinned-source.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";

const WHITESPACE_RUN_PATTERN = /\s+/g;
const ARM_PATTERN = /"([^"\\]+)"\s*(?:if\s+([^\n]*?))?\s*=>\s*"([^"\\]+)"\s*,/g;
const FALLBACK_ARM_PATTERN = /_\s*=>\s*return\s+None\s*,?/;
const META_ENTRY_PATTERN =
  /BuiltinPluginParityMeta\s*\{\s*name:\s*"([^"\\]+)"\s*,\s*classification:\s*BuiltinPluginClassification::[A-Za-z]+\s*,\s*priority:\s*(\d+)\s*,/g;
const META_OPENING_PATTERN = /BuiltinPluginParityMeta\s*\{/g;
const STRING_LIST_PATTERN = /^\[\s*((?:"[^"\\]*"\s*,\s*)*"[^"\\]*"\s*,?)\s*\]$/;
const STRING_ITEM_PATTERN = /"([^"\\]*)"/g;
const MATCHES_MODE_PATTERN = /matches!\(\s*\*mode\s*,\s*((?:"[^"\\]+"\s*\|\s*)*"[^"\\]+")\s*\)/g;

const RAW_STRING_PATTERN = /^b?r(#*)"/;
const CHAR_LITERAL_PATTERN = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'\n])'/u;
const IDENTIFIER_CHARACTER_PATTERN = /[A-Za-z0-9_]/;

/**
 * The index just past the string, raw string or char literal that starts at
 * `index` in `code`, or -1 when none starts there. A `'` that does not open a
 * char literal is a lifetime.
 */
function literalEnd(code, index) {
  const character = code[index];
  if ((character === "r" || character === "b") && !IDENTIFIER_CHARACTER_PATTERN.test(code[index - 1] ?? "")) {
    const raw = RAW_STRING_PATTERN.exec(code.slice(index, index + 260));
    if (raw) {
      const close = `"${raw[1]}`;
      const end = code.indexOf(close, index + raw[0].length);
      if (end === -1) throw new Error("unterminated raw string literal");
      return end + close.length;
    }
  }
  if (character === '"') {
    let end = index + 1;
    while (end < code.length && code[end] !== '"') end += code[end] === "\\" ? 2 : 1;
    if (end >= code.length) throw new Error("unterminated string literal");
    return end + 1;
  }
  if (character === "'") {
    const literal = CHAR_LITERAL_PATTERN.exec(code.slice(index, index + 16));
    if (literal) return index + literal[0].length;
  }
  return -1;
}

/**
 * `source` with Rust comments removed and every literal kept intact, so a
 * `//` or a brace inside a string is neither a comment nor structure.
 */
export function stripRustComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const end = literalEnd(source, index);
    if (end !== -1) {
      out += source.slice(index, end);
      index = end;
    } else if (source.startsWith("//", index)) {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd;
    } else if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (depth > 0) {
        if (index >= source.length) throw new Error("unterminated block comment");
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      out += " ";
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

/** The index just past the delimiter that closes the one opening at `open`. */
function closingIndex(code, open, opening, closing) {
  let depth = 0;
  let index = open;
  while (index < code.length) {
    const end = literalEnd(code, index);
    if (end !== -1) {
      index = end;
      continue;
    }
    if (code[index] === opening) depth += 1;
    else if (code[index] === closing) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new Error(`unbalanced ${opening}${closing}`);
}

/** The whole text of `fn name(...) { ... }` in comment-stripped `code`. */
export function rustFunction(code, name) {
  const marker = `fn ${name}(`;
  const start = code.indexOf(marker);
  if (start === -1) throw new Error(`\`fn ${name}\` not found`);
  if (code.indexOf(marker, start + 1) !== -1) throw new Error(`\`fn ${name}\` is defined twice`);
  const open = code.indexOf("{", start);
  return code.slice(start, closingIndex(code, open, "{", "}"));
}

function collapse(text) {
  return text.replace(WHITESPACE_RUN_PATTERN, " ").trim();
}

/** Edge's `namespace_scoped_resource_kind` arms, in match order. */
export function parseNamespaceScopedKinds(adminSource) {
  const body = rustFunction(stripRustComments(adminSource), "namespace_scoped_resource_kind");
  const marker = "match *segments.first()?";
  const at = body.indexOf(marker);
  if (at === -1) throw new Error("`namespace_scoped_resource_kind` no longer matches `*segments.first()?`");
  const open = body.indexOf("{", at);
  const block = body.slice(open + 1, closingIndex(body, open, "{", "}") - 1);
  const arms = [...block.matchAll(ARM_PATTERN)].map(([, segment, guard, kind]) => ({
    segment,
    guard: guard === undefined ? null : guard.replace(WHITESPACE_RUN_PATTERN, ""),
    kind,
  }));
  const rest = block.replace(ARM_PATTERN, "");
  if (!FALLBACK_ARM_PATTERN.test(rest) || rest.replace(FALLBACK_ARM_PATTERN, "").trim() !== "") {
    throw new Error(
      `\`namespace_scoped_resource_kind\` has an arm the parser does not understand: ${collapse(rest)}`,
    );
  }
  return arms;
}

/** SHA-256 of the named functions, comments removed and whitespace collapsed. */
export function allowlistDigest(adminSource, names) {
  const code = stripRustComments(adminSource);
  const text = names.map((name) => collapse(rustFunction(code, name))).join("\n");
  return createHash("sha256").update(text).digest("hex");
}

/** Every built-in's default priority from `BUILTIN_PLUGIN_PARITY_META`. */
export function parsePluginPriorities(paritySource) {
  const code = stripRustComments(paritySource);
  const marker = "pub const BUILTIN_PLUGIN_PARITY_META";
  const at = code.indexOf(marker);
  if (at === -1) throw new Error("`BUILTIN_PLUGIN_PARITY_META` not found");
  const open = code.indexOf("[", code.indexOf("=", at));
  const table = code.slice(open, closingIndex(code, open, "[", "]"));
  const entries = [...table.matchAll(META_ENTRY_PATTERN)];
  const declared = [...table.matchAll(META_OPENING_PATTERN)].length;
  if (entries.length !== declared) {
    throw new Error(
      `read ${entries.length} of ${declared} BUILTIN_PLUGIN_PARITY_META entries: an entry no longer starts with name, classification, priority`,
    );
  }
  const priorities = new Map();
  for (const [, name, priority] of entries) {
    if (priorities.has(name)) throw new Error(`\`${name}\` appears twice in BUILTIN_PLUGIN_PARITY_META`);
    priorities.set(name, Number(priority));
  }
  return priorities;
}

function stringList(literal, where) {
  const list = STRING_LIST_PATTERN.exec(collapse(literal));
  if (!list) throw new Error(`${where} is not a plain list of string literals`);
  return [...list[1].matchAll(STRING_ITEM_PATTERN)].map(([, item]) => item);
}

/**
 * `ADMIN_METRICS_MODES`, the modes `contract_fixtures` serves a proxy-backed
 * payload for, and the rest: the modes answered with `empty_proxy_metrics`.
 */
export function parseMetricsModes(metricsSource) {
  const code = stripRustComments(metricsSource);
  const marker = "pub const ADMIN_METRICS_MODES: &[&str] = &";
  const at = code.indexOf(marker);
  if (at === -1) throw new Error("`ADMIN_METRICS_MODES` not found as a `&[&str]` constant");
  const open = at + marker.length;
  if (code[open] !== "[") throw new Error("`ADMIN_METRICS_MODES` is not a list literal");
  const modes = stringList(code.slice(open, closingIndex(code, open, "[", "]")), "ADMIN_METRICS_MODES");
  const fixtures = rustFunction(code, "contract_fixtures");
  const serving = [...fixtures.matchAll(MATCHES_MODE_PATTERN)];
  if (serving.length !== 1) {
    throw new Error(
      `\`contract_fixtures\` has ${serving.length} \`matches!(*mode, …)\` mode lists; expected exactly one`,
    );
  }
  const servingModes = [...serving[0][1].matchAll(STRING_ITEM_PATTERN)].map(([, mode]) => mode);
  const unknown = servingModes.filter((mode) => !modes.includes(mode));
  if (unknown.length > 0) throw new Error(`\`contract_fixtures\` names modes outside ADMIN_METRICS_MODES: ${unknown.join(", ")}`);
  return { modes, servingModes, noProxyStateModes: modes.filter((mode) => !servingModes.includes(mode)) };
}

function setDifference(left, right) {
  return [...new Set(left)].filter((item) => !right.includes(item));
}

/** Differences between Edge's default priorities and Foundry's table. */
export function comparePriorities(edge, foundry = PLUGIN_DEFAULT_PRIORITY) {
  const findings = [];
  for (const [name, priority] of edge) {
    if (!foundry.has(name)) findings.push(`plugin \`${name}\` (priority ${priority}) is missing`);
    else if (foundry.get(name) !== priority) {
      findings.push(`plugin \`${name}\` has priority ${priority}, Foundry records ${foundry.get(name)}`);
    }
  }
  for (const name of foundry.keys()) {
    if (!edge.has(name)) findings.push(`plugin \`${name}\` is no longer a built-in`);
  }
  return findings;
}

function describeArm(arm) {
  return `"${arm.segment}"${arm.guard ? ` if ${arm.guard}` : ""} => "${arm.kind}"`;
}

/** Differences between Edge's match arms and Foundry's table, arm by arm in match order. */
export function compareKinds(edge, foundry = EDGE_NAMESPACE_SCOPED_KINDS) {
  const findings = [];
  for (let index = 0; index < Math.max(edge.length, foundry.length); index += 1) {
    const theirs = edge[index] ? describeArm(edge[index]) : "nothing";
    const ours = foundry[index] ? describeArm(foundry[index]) : "nothing";
    if (theirs !== ours) {
      findings.push(`namespace_scoped_resource_kind arm ${index + 1} is ${theirs}; Foundry records ${ours}`);
    }
  }
  return findings;
}

/** Differences between Edge's metrics modes and Foundry's. */
export function compareMetricsModes(
  edge,
  { modes = METRICS_MODES, noProxyStateModes = NO_PROXY_STATE_MODES } = {},
) {
  const findings = [];
  const missing = setDifference(edge.modes, modes);
  const extra = setDifference(modes, edge.modes);
  if (missing.length > 0) findings.push(`gateway modes Foundry does not name: ${missing.join(", ")}`);
  if (extra.length > 0) findings.push(`gateway modes Edge no longer has: ${extra.join(", ")}`);
  const skeletonMissing = setDifference(edge.noProxyStateModes, noProxyStateModes);
  const skeletonExtra = setDifference(noProxyStateModes, edge.noProxyStateModes);
  if (skeletonMissing.length > 0) {
    findings.push(`modes Edge answers with placeholders that Foundry shows as measured: ${skeletonMissing.join(", ")}`);
  }
  if (skeletonExtra.length > 0) {
    findings.push(`modes Foundry hides although Edge measures them: ${skeletonExtra.join(", ")}`);
  }
  return findings;
}

/** One finding list per source; a source the parser cannot read is a finding too. */
export function edgeSourceParity({ parity, admin, metrics }, foundry = {}) {
  const attempt = (compare) => {
    try {
      return compare();
    } catch (error) {
      return [`unreadable: ${error?.message ?? error}`];
    }
  };
  return {
    chainOrder: attempt(() => comparePriorities(parsePluginPriorities(parity), foundry.priorities)),
    namespaceRoutes: attempt(() => {
      const findings = compareKinds(parseNamespaceScopedKinds(admin), foundry.kinds);
      const source = foundry.routeSource ?? EDGE_NAMESPACE_ROUTE_SOURCE;
      const digest = allowlistDigest(admin, source.allowlistFunctions);
      if (digest !== source.allowlistDigest) {
        findings.push(
          `${source.allowlistFunctions.join(" / ")} changed (digest ${digest}): re-read them ` +
            "and bring NAMESPACE_SAFE_GLOBAL_ROUTES in line",
        );
      }
      return findings;
    }),
    metricsModes: attempt(() => compareMetricsModes(parseMetricsModes(metrics), foundry.metrics)),
  };
}

/** The transcriptions and the commit each records. */
export const EDGE_SOURCE_TRANSCRIPTIONS = [
  { key: "chainOrder", source: PLUGIN_CHAIN_ORDER_SOURCE, file: "src/lib/pluginChainOrder.ts" },
  { key: "namespaceRoutes", source: EDGE_NAMESPACE_ROUTE_SOURCE, file: "server/proxy-path.ts" },
  { key: "metricsModes", source: ADMIN_METRICS_SOURCE, file: "src/lib/adminMetricsReporting.ts" },
];

/** Fetch the three Edge sources at `ref` and compare them. */
export async function edgeSourceParityAt(ref, { fetchSource = fetchPinnedSource } = {}) {
  const [parity, admin, metrics] = await Promise.all(
    EDGE_SOURCE_TRANSCRIPTIONS.map(({ source }) => fetchSource(source, ref)),
  );
  return edgeSourceParity({ parity, admin, metrics });
}

/** Findings as Markdown lines, one per finding. */
export function parityMarkdown(result) {
  return EDGE_SOURCE_TRANSCRIPTIONS.flatMap(({ key, source, file }) =>
    result[key].map((finding) => `- \`${source.path}\`: ${finding} (bring \`${file}\` in line)`),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const pinned = readSupportedPairing().edge.source_commit;
  const ref = process.env.FERRUM_EDGE_REF?.trim() || pinned;
  const result = await edgeSourceParityAt(ref);
  const stale = EDGE_SOURCE_TRANSCRIPTIONS.filter(({ source }) => source.commit !== ref);
  console.log(JSON.stringify({ ref, ...result }, null, 2));
  const lines = parityMarkdown(result);
  for (const { source, file } of stale) {
    lines.push(`- \`${file}\` records Edge commit ${source.commit}, not the checked ${ref}`);
  }
  if (lines.length > 0) {
    console.error(
      `\nFoundry's transcriptions of Ferrum Edge source differ from ${ref}:\n${lines.join("\n")}\n\n` +
        "Re-read each named Edge file at that commit, bring the Foundry file in line, and record " +
        "the commit in its *_SOURCE constant. A stale chain order misjudges which Consumers a proxy " +
        "admits; a stale route table lets the BFF forward what Edge refuses or refuse what it " +
        "serves; stale metrics modes show placeholders as measurements.",
    );
    process.exit(1);
  }
}
