/**
 * Strict parser for `contracts/ferrum-contracts/PIN`, in the one format
 * ferrum-contracts `docs/consumer-pins.md` defines for every consumer:
 *
 *   tag <tag>
 *   commit <40 lowercase hex>
 *   edge_version <vX.Y.Z>                 (optional)
 *   <64 lowercase hex>  <path>            (one or more, byte-sorted by path)
 *
 * ASCII, LF line endings, a final newline, no blank lines, comments, or
 * surrounding spaces. Every line must match its position; an unknown line is
 * an error, never skipped (consumer-pins.md "Required checks" 1-3). The tree
 * and content checks (4-5) need the filesystem and live in the drift test.
 */

const TAG_LINE_PATTERN = /^tag (contracts-edge-[0-9]+\.[0-9]+\.[0-9]+(?:-r(?:[2-9]|[1-9][0-9]+))?)$/;
const COMMIT_LINE_PATTERN = /^commit ([0-9a-f]{40})$/;
const EDGE_VERSION_LINE_PATTERN = /^edge_version (v[0-9]+\.[0-9]+\.[0-9]+)$/;
const ROW_LINE_PATTERN = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(lineNumber, reason) {
  throw new Error(`PIN line ${lineNumber}: ${reason}`);
}

function validatePath(path, lineNumber) {
  if (path === "PIN") fail(lineNumber, "the PIN file never lists itself");
  for (const segment of path.split("/")) {
    if (!PATH_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      fail(lineNumber, "path must be /-separated segments of [A-Za-z0-9._-], none empty, . or ..");
    }
  }
}

/**
 * Parse PIN text. Returns `{ tag, commit, edgeVersion, files }`, where `files`
 * maps each path to its sha256 in PIN order; throws on any deviation.
 */
export function parseContractsPin(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("PIN is empty");
  if (text.startsWith("﻿")) throw new Error("PIN must not start with a byte order mark");
  if (text.includes("\r")) throw new Error("PIN must use LF line endings, with no carriage return");
  if (!text.endsWith("\n")) throw new Error("PIN must end with a newline");

  const lines = text.slice(0, -1).split("\n");
  let index = 0;
  const next = () => lines[index++];

  const tag = TAG_LINE_PATTERN.exec(next() ?? "")?.[1];
  if (!tag) fail(1, "expected `tag contracts-edge-X.Y.Z[-rN]`");
  const commit = COMMIT_LINE_PATTERN.exec(next() ?? "")?.[1];
  if (!commit) fail(2, "expected `commit <40 lowercase hex digits>`");

  let edgeVersion;
  const optional = EDGE_VERSION_LINE_PATTERN.exec(lines[index] ?? "");
  if (optional) {
    edgeVersion = optional[1];
    index += 1;
  }

  const files = new Map();
  let previous;
  for (; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const match = ROW_LINE_PATTERN.exec(lines[index]);
    if (!match) {
      fail(lineNumber, "expected `<64 lowercase hex>  <path>` (two spaces); unknown lines are not allowed");
    }
    const [, digest, path] = match;
    validatePath(path, lineNumber);
    if (previous !== undefined && !(previous < path)) {
      fail(
        lineNumber,
        path === previous ? `${path} is listed twice` : "rows must be sorted by path in byte order",
      );
    }
    files.set(path, digest);
    previous = path;
  }
  if (files.size === 0) throw new Error("PIN must list at least one file");
  return { tag, commit, edgeVersion, files };
}
