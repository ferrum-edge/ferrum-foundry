/* ------------------------------------------------------------------ */
/*  Admin API coverage table check                                     */
/* ------------------------------------------------------------------ */

/**
 * `docs/admin-api-coverage.md` classifies every operation (path + method) of
 * Ferrum Edge's admin API at the pinned release: used by the UI, forwarded by
 * the BFF but unused, or denied by the BFF. This keeps that table honest.
 *
 * Offline (the unit test, `admin-api-coverage.test.mjs`): the table parses,
 * has no duplicate row, records the pinned `edge.source_commit`, and every
 * row's BFF columns agree with `server/proxy-path.ts`.
 *
 * Online (this CLI, in the Pinned Gateway Contract job): it fetches
 * `openapi.yaml` at `edge.source_commit`, checks the SHA-256 the table
 * records, and fails when the spec has an operation the table lacks, or the
 * table has one the spec does not. Moving the Edge pin therefore fails the
 * unit test until the table is re-checked against the new spec, and fails
 * this check until every new operation is classified.
 *
 *   node scripts/admin-api-coverage.mjs
 *
 * The check is pinned-only: the table records one Edge commit, and only that
 * commit (`edge.source_commit`) is ever checked against it.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fetchPinnedSource } from "./pinned-source.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";

export const COVERAGE_DOC = new URL("../docs/admin-api-coverage.md", import.meta.url);
export const OPENAPI_SOURCE = { repository: "ferrum-edge/ferrum-edge", path: "openapi.yaml" };

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];
/** Path Item keys that are not operations (OpenAPI 3.1). */
const PATH_ITEM_KEYS = new Set(["parameters", "summary", "description", "servers", "$ref"]);
export const FOUNDRY_CLASSES = new Set(["UI", "Unused", "Denied"]);
export const SCOPED_CLASSES = new Set(["Allowed", "Refused"]);

const PATH_KEY_PATTERN = /^ {2}(\/[^\s:]*):\s*$/;
const ITEM_KEY_PATTERN = /^ {4}([A-Za-z$][A-Za-z0-9_$-]*):/;
const TOP_LEVEL_PATTERN = /^[^\s#]/;
const ROW_PATTERN = /^\|\s*`([A-Z]+)`\s*\|\s*`(\/[^`]*)`\s*\|\s*([A-Za-z]+)\s*\|\s*([A-Za-z]+)\s*\|(.*)\|\s*$/;
const HEADER_PATTERN = /^\|\s*Method\s*\|\s*Path\s*\|\s*Foundry\s*\|\s*Scoped session\s*\|\s*Where or why\s*\|$/;
const SEPARATOR_PATTERN = /^\|(?:\s*:?-{3,}:?\s*\|){5}$/;
const HEADING_PATTERN = /^#{1,6}\s/;
const MARKER_PATTERN = /<!--\s*admin-api-coverage\s+source_commit=([0-9a-f]{40})\s+spec_sha256=([0-9a-f]{64})\s+paths=(\d+)\s+operations=(\d+)\s*-->/;
const SOURCE_FILE_PATTERN = /`((?:src|server)\/[^`]+\.tsx?)`/;

/** `METHOD /path`, the key both sides compare on. */
export function operationKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Every operation of `spec` (Edge's `openapi.yaml`) as `METHOD /path`, in
 * document order, plus the number of paths. Edge writes `paths:` in block
 * style: path keys at two spaces, Path Item keys at four. Any other key at
 * four spaces, a quoted or flow-style path, or a repeated path or operation
 * throws, so the check fails rather than count a shape it does not understand.
 */
export function parseOpenApiOperations(spec) {
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line === "paths:");
  if (start < 0) throw new Error("openapi.yaml has no top-level `paths:`");
  const operations = [];
  const paths = new Set();
  let path = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (TOP_LEVEL_PATTERN.test(line)) break;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.startsWith("  ") && !line.startsWith("   ")) {
      const key = PATH_KEY_PATTERN.exec(line);
      if (!key) throw new Error(`line ${index + 1}: unrecognised path key \`${line.trim()}\``);
      if (paths.has(key[1])) throw new Error(`line ${index + 1}: path ${key[1]} appears twice`);
      path = key[1];
      paths.add(path);
      continue;
    }
    if (line.startsWith("    ") && !line.startsWith("     ")) {
      if (path === null) throw new Error(`line ${index + 1}: Path Item key outside a path`);
      const key = ITEM_KEY_PATTERN.exec(line);
      if (!key) throw new Error(`line ${index + 1}: unrecognised Path Item key \`${line.trim()}\``);
      if (HTTP_METHODS.includes(key[1])) {
        const operation = operationKey(key[1], path);
        if (operations.includes(operation)) throw new Error(`line ${index + 1}: ${operation} appears twice`);
        operations.push(operation);
      } else if (!PATH_ITEM_KEYS.has(key[1])) {
        throw new Error(`line ${index + 1}: unrecognised Path Item key \`${key[1]}\` under ${path}`);
      }
    }
  }
  if (paths.size === 0) throw new Error("openapi.yaml declares no paths");
  return { operations, pathCount: paths.size };
}

/**
 * The coverage table: its recorded source (commit, spec digest, counts) and
 * one row per operation. A malformed row, an unknown class, or a duplicate
 * operation throws.
 */
export function parseCoverageTable(markdown) {
  const marker = MARKER_PATTERN.exec(markdown);
  if (!marker) throw new Error("docs/admin-api-coverage.md has no admin-api-coverage marker");
  const rows = [];
  const seen = new Set();
  // Every line Markdown would render as part of a table is accounted for: a
  // coverage table is its header, its separator, then body rows up to the
  // next blank line or heading, and every body row must parse. A pipe line
  // outside a coverage table is refused, so no row GitHub shows can escape
  // the check through spacing or placement.
  let state = "outside";
  for (const [index, raw] of markdown.split("\n").entries()) {
    const line = raw.trim();
    if (state === "body" && (line === "" || HEADING_PATTERN.test(line))) state = "outside";
    if (state === "outside") {
      if (HEADER_PATTERN.test(line)) state = "separator";
      else if (line.startsWith("|")) throw new Error(`line ${index + 1}: table row outside a coverage table`);
      continue;
    }
    if (state === "separator") {
      if (!SEPARATOR_PATTERN.test(line)) throw new Error(`line ${index + 1}: coverage table header without a separator`);
      state = "body";
      continue;
    }
    const row = ROW_PATTERN.exec(line);
    if (!row) throw new Error(`line ${index + 1}: malformed coverage row`);
    const [, method, path, foundry, scoped, note] = row;
    if (!HTTP_METHODS.includes(method.toLowerCase())) throw new Error(`line ${index + 1}: unknown method ${method}`);
    if (!FOUNDRY_CLASSES.has(foundry)) throw new Error(`line ${index + 1}: unknown Foundry class ${foundry}`);
    if (!SCOPED_CLASSES.has(scoped)) throw new Error(`line ${index + 1}: unknown scoped-session class ${scoped}`);
    if (note.trim() === "") throw new Error(`line ${index + 1}: ${method} ${path} needs a reason or a source`);
    const key = operationKey(method, path);
    if (seen.has(key)) throw new Error(`line ${index + 1}: ${key} appears twice`);
    seen.add(key);
    rows.push({ method, path, key, foundry, scoped, note: note.trim(), source: SOURCE_FILE_PATTERN.exec(note)?.[1] ?? null });
  }
  return {
    sourceCommit: marker[1],
    specSha256: marker[2],
    pathCount: Number(marker[3]),
    operationCount: Number(marker[4]),
    rows,
  };
}

/** Operations the spec has and the table lacks (`missing`), and the reverse (`extra`). */
export function compareCoverage(specOperations, rows) {
  const documented = new Set(rows.map((row) => row.key));
  const served = new Set(specOperations);
  return {
    missing: specOperations.filter((operation) => !documented.has(operation)),
    extra: rows.map((row) => row.key).filter((operation) => !served.has(operation)),
  };
}

/** Every finding for one fetched spec against the table, as messages. */
export function checkCoverage(spec, table, ref) {
  const findings = [];
  const digest = createHash("sha256").update(spec).digest("hex");
  if (digest !== table.specSha256) {
    findings.push(`openapi.yaml at ${ref} has SHA-256 ${digest}; the table records ${table.specSha256}`);
  }
  if (table.sourceCommit !== ref) {
    findings.push(`the table records source_commit ${table.sourceCommit}, not the checked Edge source ${ref}`);
  }
  const { operations, pathCount } = parseOpenApiOperations(spec);
  if (pathCount !== table.pathCount) findings.push(`the spec has ${pathCount} paths; the table records ${table.pathCount}`);
  if (operations.length !== table.operationCount) {
    findings.push(`the spec has ${operations.length} operations; the table records ${table.operationCount}`);
  }
  const { missing, extra } = compareCoverage(operations, table.rows);
  for (const operation of missing) findings.push(`missing from the table: ${operation}`);
  for (const operation of extra) findings.push(`in the table but not in the spec: ${operation}`);
  return findings;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const ref = readSupportedPairing().edge.source_commit;
  const spec = await fetchPinnedSource(OPENAPI_SOURCE, ref);
  const table = parseCoverageTable(readFileSync(COVERAGE_DOC, "utf8"));
  const findings = checkCoverage(spec, table, ref);
  console.log(JSON.stringify({ ref, rows: table.rows.length, findings }, null, 2));
  if (findings.length > 0) {
    console.error(
      `\ndocs/admin-api-coverage.md does not match ${OPENAPI_SOURCE.path} at ${ref}:\n` +
        findings.map((finding) => `  ${finding}`).join("\n") +
        "\n\nClassify every new operation (UI, Unused or Denied, and whether a namespace-scoped " +
        "session may reach it), remove operations Edge no longer serves, then record the checked " +
        "commit, spec SHA-256 and counts in the table's marker.",
    );
    process.exit(1);
  }
}
