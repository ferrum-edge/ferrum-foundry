import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareSensitivity,
  foundryTables,
  parseKafkaSafeProperties,
  parseSensitivitySchemas,
} from "./plugin-sensitivity-drift.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";
import { PLUGIN_SENSITIVITY_SOURCE } from "../src/api/pluginSensitivity.ts";

/** Shaped like Edge's `plugin_config_projection.rs`, comments and all. */
const SOURCE = `
//! Module docs mentioning \`const fn\` and "quotes".

use serde_json::Value;

pub enum FieldSensitivity {
    Secret,
    EndpointUrl,
    RedisUrl,
    KafkaProducerProperties,
}

pub struct SensitivityRule {
    pub path: &'static [&'static str],
    pub sensitivity: FieldSensitivity,
}

const fn secret(path: &'static [&'static str]) -> SensitivityRule {
    SensitivityRule {
        path,
        sensitivity: FieldSensitivity::Secret,
    }
}

const fn endpoint_url(path: &'static [&'static str]) -> SensitivityRule {
    SensitivityRule {
        path,
        sensitivity: FieldSensitivity::EndpointUrl,
    }
}

const fn redis_url(path: &'static [&'static str]) -> SensitivityRule {
    SensitivityRule {
        path,
        sensitivity: FieldSensitivity::RedisUrl,
    }
}

/// The \`redis_url\` rule shared by every Redis-backed plugin.
const REDIS_BACKED: &[SensitivityRule] = &[redis_url(&["redis_url"])];

const NONE: &[SensitivityRule] = &[];

pub const PLUGIN_SENSITIVITY_SCHEMAS: &[(&str, &[SensitivityRule])] = &[
    // ---- Tracing ("quoted" in a comment) ----
    (
        "otel_tracing",
        &[
            endpoint_url(&["endpoint"]),
            secret(&["authorization"]),
            /* block comment */ secret(&["headers", "*"]),
        ],
    ),
    ("cors", NONE),
    ("rate_limiting", REDIS_BACKED),
    (
        "kafka_logging",
        &[SensitivityRule {
            path: &["producer_config"],
            sensitivity: FieldSensitivity::KafkaProducerProperties,
        }],
    ),
];

pub const KAFKA_SAFE_PRODUCER_PROPERTIES: &[&str] = &[
    "acks",
    // a comment between entries
    "linger.ms",
];

fn is_quote(c: char) -> bool {
    c == '"' || c == '\\''
}
`;

const PARSED = new Map([
  ["otel_tracing", [
    { path: ["endpoint"], sensitivity: "endpoint" },
    { path: ["authorization"], sensitivity: "secret" },
    { path: ["headers", "*"], sensitivity: "secret" },
  ]],
  ["cors", []],
  ["rate_limiting", [{ path: ["redis_url"], sensitivity: "redis" }]],
  ["kafka_logging", [{ path: ["producer_config"], sensitivity: "kafka" }]],
]);

function tables(schemas, kafka = ["acks", "linger.ms"]) {
  return { schemas, kafka: new Set(kafka) };
}

const RUST_CONSTRUCTOR = { secret: "secret", endpoint: "endpoint_url", redis: "redis_url" };

/** Foundry's table rendered back as the Rust Edge writes it. */
function renderRust({ schemas, kafka }) {
  const rule = ({ path, sensitivity }) => {
    const segments = `&[${path.map((segment) => JSON.stringify(segment)).join(", ")}]`;
    return sensitivity === "kafka"
      ? `SensitivityRule { path: ${segments}, sensitivity: FieldSensitivity::KafkaProducerProperties }`
      : `${RUST_CONSTRUCTOR[sensitivity]}(${segments})`;
  };
  const header = SOURCE.slice(0, SOURCE.indexOf("pub const PLUGIN_SENSITIVITY_SCHEMAS"));
  return [
    header,
    "pub const PLUGIN_SENSITIVITY_SCHEMAS: &[(&str, &[SensitivityRule])] = &[",
    ...[...schemas].map(([plugin, rules]) =>
      `    (${JSON.stringify(plugin)}, ${rules.length === 0 ? "NONE" : `&[${rules.map(rule).join(", ")}]`}),`),
    "];",
    "pub const KAFKA_SAFE_PRODUCER_PROPERTIES: &[&str] = &[",
    ...[...kafka].map((property) => `    ${JSON.stringify(property)},`),
    "];",
  ].join("\n");
}

test("parses Edge's table: constructors, named rule sets, struct literals, and comments", () => {
  assert.deepEqual(parseSensitivitySchemas(SOURCE), PARSED);
  assert.deepEqual(parseKafkaSafeProperties(SOURCE), new Set(["acks", "linger.ms"]));
});

test("a faithful transcription has no findings, whatever the rule order", () => {
  const reordered = new Map(PARSED);
  reordered.set("otel_tracing", [...PARSED.get("otel_tracing")].reverse());
  assert.deepEqual(compareSensitivity(tables(PARSED), tables(reordered)), []);
});

test("reports a built-in Foundry is missing, a changed rule, an extra plugin, and Kafka drift", () => {
  const edge = new Map(PARSED);
  edge.set("new_builtin", [{ path: ["token"], sensitivity: "secret" }]);
  edge.set("rate_limiting", [
    { path: ["redis_url"], sensitivity: "redis" },
    { path: ["headers", "*"], sensitivity: "secret" },
  ]);
  const foundry = new Map(PARSED);
  foundry.set("retired_builtin", []);

  assert.deepEqual(
    compareSensitivity(tables(edge, ["acks", "linger.ms", "batch.size"]), tables(foundry, ["acks", "retries"])),
    [
      {
        plugin: "rate_limiting",
        status: "changed",
        edge: ["redis redis_url", "secret headers.*"],
        foundry: ["redis redis_url"],
      },
      { plugin: "new_builtin", status: "missing", edge: ["secret token"], foundry: null },
      { plugin: "retired_builtin", status: "extra", edge: null, foundry: [] },
      {
        plugin: "KAFKA_SAFE_PRODUCER_PROPERTIES",
        status: "changed",
        edge: ["+ linger.ms", "+ batch.size"],
        foundry: ["- retries"],
      },
    ],
  );
});

test("fails loudly on a shape it cannot read rather than passing over it", () => {
  assert.throws(
    () => parseSensitivitySchemas(SOURCE.replace('("cors", NONE)', '("cors", &[jwt_claim(&["sub"])])')),
    /unknown rule constructor `jwt_claim`/,
  );
  assert.throws(
    () => parseSensitivitySchemas(SOURCE.replace("FieldSensitivity::KafkaProducerProperties,\n        }", "FieldSensitivity::Hashed,\n        }")),
    /FieldSensitivity::Hashed is not one Foundry implements/,
  );
  assert.throws(
    () => parseSensitivitySchemas(SOURCE.replace('("cors", NONE)', '("cors", EXTRA_RULES)')),
    /unknown rule set `EXTRA_RULES`/,
  );
  assert.throws(
    () => parseSensitivitySchemas(SOURCE.replace('("rate_limiting", REDIS_BACKED)', '("cors", REDIS_BACKED)')),
    /`cors` appears twice/,
  );
  assert.throws(
    () => parseSensitivitySchemas(SOURCE.replace("PLUGIN_SENSITIVITY_SCHEMAS", "RENAMED")),
    /`PLUGIN_SENSITIVITY_SCHEMAS` not found/,
  );
});

test("reads back every shape Foundry's own table uses", () => {
  const foundry = foundryTables();
  const source = renderRust(foundry);
  assert.deepEqual(compareSensitivity(
    { schemas: parseSensitivitySchemas(source), kafka: parseKafkaSafeProperties(source) },
    foundry,
  ), []);
  assert.ok(foundry.schemas.size > 50);
});

test("the table records the Edge source CI pins, so moving the pin means re-reading it", () => {
  assert.equal(PLUGIN_SENSITIVITY_SOURCE.commit, readSupportedPairing().edge.source_commit);
});
