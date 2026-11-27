import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  COVERAGE_DOC,
  checkCoverage,
  compareCoverage,
  parseCoverageTable,
  parseOpenApiOperations,
} from "./admin-api-coverage.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";
import {
  proxyPathIsAllowedForNamespace,
  proxyPathIsConsumerVerification,
  proxyPathIsDeploymentSnapshot,
  proxyPathIsMeshConfigRevisionReset,
} from "../server/proxy-path.ts";

const PATH_PARAMETER_PATTERN = /\{[^}]+\}/g;
const GATEWAY_CONTRACT_JOB_PATTERN = /\n {2}gateway-contract:\n[\s\S]*?(?=\n {2}[a-z][a-z-]*:\n|$)/;
const CHECK_STEP_PATTERN = /run: npm run check:admin-api-coverage\n/;

const table = parseCoverageTable(readFileSync(COVERAGE_DOC, "utf8"));
const pairing = readSupportedPairing();

/** A request the BFF's classifiers accept, as `server/proxy-path.test.ts` builds one. */
function proxyRequest(method, path) {
  const url = `/api/proxy${path}`;
  return { raw: { url }, url, method, params: {}, routeOptions: { url } };
}

/** The table's path template with every parameter filled in. */
function concrete(path) {
  return path.replace(PATH_PARAMETER_PATTERN, "sample-1");
}

function bffDenies(path) {
  return (
    proxyPathIsConsumerVerification(path) ||
    proxyPathIsDeploymentSnapshot(path) ||
    proxyPathIsMeshConfigRevisionReset(path)
  );
}

describe("docs/admin-api-coverage.md", () => {
  it("records the pinned Edge source, so moving the pin means re-checking the table", () => {
    assert.equal(
      table.sourceCommit,
      pairing.edge.source_commit,
      "re-check the table against openapi.yaml at the new edge.source_commit, then update its marker",
    );
    assert.equal(table.rows.length, table.operationCount, "one row per recorded operation");
    assert.ok(table.pathCount <= table.operationCount);
    assert.equal(new Set(table.rows.map((row) => row.path)).size, table.pathCount, "rows cover every recorded path");
  });

  it("agrees with the BFF's denials and namespace route ceiling for every row", () => {
    for (const row of table.rows) {
      const path = concrete(row.path);
      const label = `${row.method} ${row.path}`;
      assert.equal(bffDenies(path), row.foundry === "Denied", `${label}: Denied class disagrees with server/proxy-path.ts`);
      if (row.foundry === "Denied") {
        assert.equal(row.scoped, "Refused", `${label}: a denied operation is refused to every session`);
        continue;
      }
      assert.equal(
        proxyPathIsAllowedForNamespace(proxyRequest(row.method, path)),
        row.scoped === "Allowed",
        `${label}: Scoped session column disagrees with the namespace route ceiling`,
      );
    }
  });

  it("names an existing source file for every operation the UI uses", () => {
    for (const row of table.rows.filter((entry) => entry.foundry === "UI")) {
      assert.ok(row.source, `${row.method} ${row.path} names no src/ or server/ file`);
      assert.ok(existsSync(new URL(`../${row.source}`, import.meta.url)), `${row.source} does not exist`);
    }
  });

  it("is checked against the pinned spec in the Pinned Gateway Contract job", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.scripts["check:admin-api-coverage"], "node scripts/admin-api-coverage.mjs");
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = GATEWAY_CONTRACT_JOB_PATTERN.exec(ci)?.[0] ?? "";
    assert.match(job, CHECK_STEP_PATTERN);
  });
});

const SPEC = [
  "openapi: 3.1.0",
  "paths:",
  "  # ── Health ──",
  "  /live:",
  "    get:",
  "      summary: Liveness",
  "      description: |",
  "        post: not an operation",
  "  /proxies/{id}:",
  "    parameters:",
  "      - name: id",
  "    get:",
  "      operationId: getProxy",
  "    delete:",
  "      operationId: deleteProxy",
  "components:",
  "  schemas:",
  "    put:",
  "      type: object",
  "",
].join("\n");

describe("parseOpenApiOperations", () => {
  it("lists every operation in document order and stops at the next top-level key", () => {
    assert.deepEqual(parseOpenApiOperations(SPEC), {
      operations: ["GET /live", "GET /proxies/{id}", "DELETE /proxies/{id}"],
      pathCount: 2,
    });
  });

  it("refuses shapes it does not understand", () => {
    assert.throws(() => parseOpenApiOperations("openapi: 3.1.0\n"), /no top-level `paths:`/);
    assert.throws(() => parseOpenApiOperations("paths:\n  '/quoted':\n    get: {}\n"), /unrecognised path key/);
    assert.throws(() => parseOpenApiOperations("paths:\n  /a:\n    x-route: true\n"), /unrecognised Path Item key `x-route`/);
    assert.throws(() => parseOpenApiOperations("paths:\n  /a:\n    get: {}\n  /a:\n    put: {}\n"), /appears twice/);
    assert.throws(() => parseOpenApiOperations("paths:\n  /a:\n    get: {}\n    get: {}\n"), /GET \/a appears twice/);
  });
});

const TABLE_HEADER = ["| Method | Path | Foundry | Scoped session | Where or why |", "| --- | --- | --- | --- | --- |"];

function markerLine() {
  const digest = createHash("sha256").update(SPEC).digest("hex");
  return `<!-- admin-api-coverage source_commit=${"a".repeat(40)} spec_sha256=${digest} paths=2 operations=3 -->`;
}

function tableFor(rows) {
  return parseCoverageTable([markerLine(), "", ...TABLE_HEADER, ...rows].join("\n"));
}

describe("checkCoverage", () => {
  const rows = [
    "| `GET` | `/live` | Unused | Allowed | Liveness probe. |",
    "| `GET` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |",
    "| `DELETE` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |",
  ];

  it("passes a table that classifies exactly the spec's operations", () => {
    assert.deepEqual(checkCoverage(SPEC, tableFor(rows), "a".repeat(40)), []);
  });

  it("fails when the spec gains an operation the table lacks, or the table lists a retired one", () => {
    const findings = checkCoverage(SPEC, tableFor([rows[0], rows[1], "| `PUT` | `/proxies/{id}` | UI | Allowed | `src/api/proxies.ts`. |"]), "a".repeat(40));
    assert.ok(findings.includes("missing from the table: DELETE /proxies/{id}"));
    assert.ok(findings.includes("in the table but not in the spec: PUT /proxies/{id}"));
    assert.deepEqual(compareCoverage(["GET /a", "POST /a"], [{ key: "GET /a" }, { key: "GET /b" }]), {
      missing: ["POST /a"],
      extra: ["GET /b"],
    });
  });

  it("fails when the recorded source commit or spec digest is not the checked one", () => {
    const findings = checkCoverage(`${SPEC}\n`, tableFor(rows), "b".repeat(40));
    assert.ok(findings.some((finding) => finding.includes("has SHA-256")));
    assert.ok(findings.some((finding) => finding.includes("not the checked Edge source")));
  });

  it("refuses malformed, unclassified, unexplained, and duplicate rows", () => {
    assert.throws(() => tableFor(["| `GET` | `/a` | Maybe | Allowed | why |"]), /unknown Foundry class/);
    assert.throws(() => tableFor(["| `GET` | `/a` | UI | Sometimes | why |"]), /unknown scoped-session class/);
    assert.throws(() => tableFor(["| `GET` | `/a` | UI | Allowed |  |"]), /needs a reason/);
    assert.throws(() => tableFor(["| `GET` | `/a` | UI | Allowed | why |", "| `GET` | `/a` | UI | Allowed | why |"]), /appears twice/);
    assert.throws(() => tableFor(["| `GET` | /a | UI |"]), /malformed coverage row/);
    assert.throws(() => parseCoverageTable("| `GET` | `/a` | UI | Allowed | why |"), /no admin-api-coverage marker/);
  });

  it("parses every rendered body row whatever its spacing, so a duplicate or extra row cannot hide", () => {
    // Two spaces after the opening pipe, and an indented row: GitHub renders both.
    assert.throws(() => tableFor([rows[0], "|  `GET` | `/live` | UI | Allowed | why |"]), /GET \/live appears twice/);
    const extra = tableFor([...rows, "   |  `PUT`  |  `/live`  | UI | Allowed | why |"]);
    assert.ok(checkCoverage(SPEC, extra, "a".repeat(40)).includes("in the table but not in the spec: PUT /live"));
    // A body row without a leading pipe still renders as a row.
    assert.throws(() => tableFor([rows[0], "`PUT` | `/live` | UI | Allowed | why |"]), /malformed coverage row/);
  });

  it("refuses table rows outside a coverage table and a header without a separator", () => {
    assert.throws(
      () => parseCoverageTable([markerLine(), "", "| `GET` | `/live` | Unused | Allowed | why |"].join("\n")),
      /table row outside a coverage table/,
    );
    assert.throws(
      () => parseCoverageTable([markerLine(), "", TABLE_HEADER[0], rows[0]].join("\n")),
      /header without a separator/,
    );
    // A blank line ends a table; a later pipe line needs its own header.
    assert.throws(() => tableFor([rows[0], "", rows[1]]), /table row outside a coverage table/);
    assert.equal(tableFor([rows[0], "", ...TABLE_HEADER, rows[1]]).rows.length, 2);
  });
});
