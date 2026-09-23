/* ------------------------------------------------------------------ */
/*  The supported Foundry–Edge pairing (issue #385)                    */
/* ------------------------------------------------------------------ */

/**
 * `docs/compatibility.json` is the single source for the Ferrum Edge image
 * Foundry is qualified against. CI starts that image (`edge-image` below), and
 * `check` fails when anything else in the repository pins a different one — a
 * starter, a workflow, or a launch document that drifted would otherwise pair
 * Foundry with a gateway nobody tested.
 *
 * Changing `edge.image` is a re-qualification, not a tag edit: the pull request
 * that changes it runs every gateway-backed gate against the new image.
 *
 *   node scripts/supported-pairing.mjs edge-image   # print the pinned image
 *   node scripts/supported-pairing.mjs check        # validate and scan
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RECORD_PATH = "docs/compatibility.json";

/** Values the release step fills in. They are never guessed ahead of it. */
export const PLACEHOLDER_PREFIX = "RELEASE-STEP";

const EDGE_IMAGE = /^ferrumedge\/ferrum-edge@sha256:[0-9a-f]{64}$/;
const FOUNDRY_IMAGE = /^ferrumedge\/ferrum-foundry@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const EDGE_VERSION = /^v\d+\.\d+\.\d+$/;
const FOUNDRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Any Ferrum Edge image reference: a tag, a digest, or a bare repository name
 * (which Docker resolves to the unqualified `latest`).
 */
export const EDGE_REFERENCE = /ferrumedge\/ferrum-edge(?:@sha256:[0-9a-f]{64}|:[\w][\w.-]*)?(?![\w/-])/g;

/**
 * Files that record history rather than the current pairing. Everything else
 * that names a Ferrum Edge image must name `edge.image`.
 */
export const HISTORY_FILES = new Set([
  "CHANGELOG.md",
  RECORD_PATH,
  "docs/compatibility.md",
]);
/** The checker and its fixtures name other images on purpose. */
const SCANNER_FILES = new Set(["scripts/supported-pairing.mjs", "scripts/supported-pairing.test.mjs"]);
const RELEASE_NOTES_DIR = "docs/release-notes/";
/** The draft for the next release is current, not history. */
export const UNRELEASED_NOTES = `${RELEASE_NOTES_DIR}UNRELEASED.md`;

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-server",
  "coverage",
  "e2e-report",
  "e2e-results",
  "test-results",
  "playwright-report",
]);
const TEXT_EXTENSIONS = /\.(?:md|mdx|json|ya?ml|mjs|cjs|js|jsx|ts|tsx|sh|conf|txt|toml|html|css|example)$|(?:^|\/)(?:Dockerfile|\.dockerignore|\.gitignore)$/;

export function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

export function readSupportedPairing(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, RECORD_PATH), "utf8"));
}

/** Structural problems with the record itself, as readable strings. */
export function validatePairing(record) {
  const errors = [];
  const edge = record?.edge ?? {};
  const foundry = record?.foundry ?? {};

  if (!["candidate", "released"].includes(record?.status)) {
    errors.push('status must be "candidate" or "released"');
  }
  if (!EDGE_IMAGE.test(edge.image ?? "")) {
    errors.push("edge.image must be ferrumedge/ferrum-edge@sha256:<64 hex>; tags are mutable");
  }
  if (!EDGE_VERSION.test(edge.version ?? "")) {
    errors.push("edge.version must be a published vX.Y.Z release");
  }
  if (!COMMIT.test(edge.source_commit ?? "")) {
    errors.push("edge.source_commit must be a full commit SHA");
  }
  for (const platform of ["linux/amd64", "linux/arm64"]) {
    if (!DIGEST.test(edge.platform_manifests?.[platform] ?? "")) {
      errors.push(`edge.platform_manifests["${platform}"] must be a sha256 digest`);
    }
  }
  for (const retired of edge.retired_images ?? []) {
    if (retired?.image === edge.image) errors.push("edge.image is listed as retired");
  }

  const released = record?.status === "released";
  const fields = [
    ["version", FOUNDRY_VERSION],
    ["source_commit", COMMIT],
    ["image", FOUNDRY_IMAGE],
    ["ci_evidence", /^https:\/\/github\.com\/ferrum-edge\/ferrum-foundry\/actions\/runs\/\d+/],
  ];
  for (const [field, pattern] of fields) {
    const value = foundry[field];
    if (isPlaceholder(value)) {
      if (released) errors.push(`foundry.${field} is still a release-step placeholder`);
    } else if (typeof value !== "string" || !pattern.test(value)) {
      errors.push(`foundry.${field} is neither a valid value nor a ${PLACEHOLDER_PREFIX} placeholder`);
    }
  }
  return errors;
}

function* walk(root, directory = root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(root, path);
    } else if (entry.isFile()) {
      const file = relative(root, path).split(sep).join("/");
      if (TEXT_EXTENSIONS.test(file)) yield file;
    }
  }
}

function isExempt(file) {
  return HISTORY_FILES.has(file)
    || SCANNER_FILES.has(file)
    || (file.startsWith(RELEASE_NOTES_DIR) && file !== UNRELEASED_NOTES);
}

/**
 * Every place outside the history files that pins a Ferrum Edge image other
 * than `edge.image`, or still names a retired digest in any form.
 */
export function findPairingDrift(record, root = REPO_ROOT) {
  const drift = [];
  const retiredDigests = (record.edge?.retired_images ?? [])
    .map((retired) => retired.image?.split("@")[1])
    .filter(Boolean);
  for (const file of walk(root)) {
    if (isExempt(file)) continue;
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      for (const [reference] of text.matchAll(EDGE_REFERENCE)) {
        if (reference !== record.edge.image) {
          drift.push({ file, line: index + 1, found: reference });
        }
      }
      for (const digest of retiredDigests) {
        if (text.includes(digest.slice("sha256:".length))) {
          drift.push({ file, line: index + 1, found: `retired ${digest}` });
        }
      }
    });
  }
  return drift;
}

/** Files that must name the pinned image, because they launch or document it. */
export const REQUIRED_REFERENCES = [
  "deploy/starter/compose.yaml",
  "CLAUDE.md",
];

export function missingRequiredReferences(record, root = REPO_ROOT) {
  return REQUIRED_REFERENCES.filter(
    (file) => !readFileSync(join(root, file), "utf8").includes(record.edge.image),
  );
}

function main(command) {
  const record = readSupportedPairing();
  const errors = validatePairing(record);
  if (errors.length > 0) {
    throw new Error(`${RECORD_PATH} is invalid:\n${errors.join("\n")}`);
  }
  if (command === "edge-image") {
    console.log(record.edge.image);
    return;
  }
  if (command !== "check") {
    throw new Error("usage: supported-pairing.mjs edge-image|check");
  }
  const drift = findPairingDrift(record);
  const missing = missingRequiredReferences(record);
  if (drift.length > 0 || missing.length > 0) {
    throw new Error([
      `Ferrum Edge references disagree with ${RECORD_PATH} (${record.edge.image}):`,
      ...drift.map(({ file, line, found }) => `  ${file}:${line} pins ${found}`),
      ...missing.map((file) => `  ${file} does not name the supported image`),
    ].join("\n"));
  }
  console.log(JSON.stringify({ aligned: true, edge: record.edge.version, image: record.edge.image }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
