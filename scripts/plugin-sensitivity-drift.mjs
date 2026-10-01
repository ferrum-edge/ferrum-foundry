/* ------------------------------------------------------------------ */
/*  Plugin configuration sensitivity drift check (issue #487)          */
/* ------------------------------------------------------------------ */

/**
 * `src/api/pluginSensitivity.ts` transcribes Ferrum Edge's per-plugin
 * projection table (`PLUGIN_SENSITIVITY_SCHEMAS`) and its safe librdkafka
 * property list (`KAFKA_SAFE_PRODUCER_PROPERTIES`). Foundry uses them to
 * decide which submitted plugin `config` values a failed write must not echo.
 * A built-in plugin missing from the table falls to the unknown-plugin
 * fallback (every string secret), and a rule missing from it lets a value Edge
 * hides from a read come back in a refusal, so a stale table is a defect.
 *
 * This fetches `plugin_config_projection.rs` at the commit of the Edge image
 * CI qualifies (`edge.source_commit` in `docs/compatibility.json`), parses
 * both tables, and fails when either differs from Foundry's — or when the
 * table does not record that commit as the one it was checked against, so
 * moving the pin always means re-reading the table.
 *
 *   node scripts/plugin-sensitivity-drift.mjs            # the pinned Edge
 *   FERRUM_EDGE_REF=main node scripts/plugin-sensitivity-drift.mjs
 */

import {
  KAFKA_SAFE_PRODUCER_PROPERTIES,
  PLUGIN_SENSITIVITY,
  PLUGIN_SENSITIVITY_SOURCE,
} from "../src/api/pluginSensitivity.ts";
import { readSupportedPairing } from "./supported-pairing.mjs";

/** Edge's `FieldSensitivity` variants, as Foundry names them. */
export const SENSITIVITY_VARIANTS = {
  Secret: "secret",
  EndpointUrl: "endpoint",
  RedisUrl: "redis",
  KafkaProducerProperties: "kafka",
};

const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", "&", ":", ";", "="]);

/**
 * Rust tokens from `source` onward: identifiers, string literals, `::` and
 * single punctuation, with comments and whitespace dropped. Only the table
 * literals are ever tokenized, so char literals and lifetimes (`'static`)
 * elsewhere in the file never reach it; a `'` that does is a token the parser
 * refuses.
 */
function* rustTokens(source, start = 0) {
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new Error("unterminated block comment");
      index = end + 2;
    } else if (character === '"') {
      let value = "";
      index += 1;
      while (source[index] !== '"') {
        if (index >= source.length) throw new Error("unterminated string literal");
        if (source[index] === "\\") {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      yield { type: "string", value };
    } else if (source.startsWith("::", index)) {
      index += 2;
      yield { type: "punct", value: "::" };
    } else if (PUNCTUATION.has(character)) {
      index += 1;
      yield { type: "punct", value: character };
    } else {
      const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index, index + 256));
      if (identifier) {
        index += identifier[0].length;
        yield { type: "ident", value: identifier[0] };
      } else {
        index += 1;
        yield { type: "other", value: character };
      }
    }
  }
}

class TokenStream {
  constructor(source, start) {
    this.tokens = rustTokens(source, start);
    this.peeked = null;
  }

  peek() {
    if (!this.peeked) {
      const next = this.tokens.next();
      this.peeked = next.done ? { type: "end", value: "" } : next.value;
    }
    return this.peeked;
  }

  next() {
    const token = this.peek();
    this.peeked = null;
    return token;
  }

  expect(value) {
    const token = this.next();
    if (token.value !== value || (token.type !== "punct" && token.type !== "ident")) {
      throw new Error(`expected \`${value}\`, found \`${token.value}\``);
    }
    return token;
  }

  string() {
    const token = this.next();
    if (token.type !== "string") throw new Error(`expected a string, found \`${token.value}\``);
    return token.value;
  }

  identifier() {
    const token = this.next();
    if (token.type !== "ident") throw new Error(`expected an identifier, found \`${token.value}\``);
    return token.value;
  }

  /** `&[ item, item, … ]`, a trailing comma allowed. */
  slice(item) {
    this.expect("&");
    this.expect("[");
    const items = [];
    while (this.peek().value !== "]") {
      items.push(item());
      if (this.peek().value === ",") this.next();
      else if (this.peek().value !== "]") {
        throw new Error(`expected \`,\` or \`]\`, found \`${this.peek().value}\``);
      }
    }
    this.next();
    return items;
  }
}

/** Where the literal of the constant `name` begins, just past its `=`. */
function constantLiteral(source, name) {
  const declaration = new RegExp(`\\bconst\\s+${name}\\s*:[^=]*=`).exec(source);
  if (!declaration) throw new Error(`\`${name}\` not found`);
  return declaration.index + declaration[0].length;
}

/**
 * The rule constructors the file defines (`const fn secret(path) ->
 * SensitivityRule { SensitivityRule { path, sensitivity:
 * FieldSensitivity::Secret } }`), by name.
 */
function ruleConstructors(source) {
  const constructors = new Map();
  const pattern =
    /\bconst\s+fn\s+([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*->\s*SensitivityRule\s*\{\s*SensitivityRule\s*\{\s*path\s*,\s*sensitivity\s*:\s*FieldSensitivity::([A-Za-z]+)\s*,?\s*\}\s*\}/g;
  for (const [, name, variant] of source.matchAll(pattern)) {
    constructors.set(name, variant);
  }
  return constructors;
}

function sensitivityOf(variant) {
  const sensitivity = SENSITIVITY_VARIANTS[variant];
  if (!sensitivity) {
    throw new Error(
      `FieldSensitivity::${variant} is not one Foundry implements; ` +
        "secretRedaction.ts needs a projection for it before the table can be re-synced",
    );
  }
  return sensitivity;
}

function parseRule(tokens, constructors) {
  const name = tokens.identifier();
  if (name === "SensitivityRule") {
    tokens.expect("{");
    const rule = {};
    while (tokens.peek().value !== "}") {
      const field = tokens.identifier();
      tokens.expect(":");
      if (field === "path") {
        rule.path = tokens.slice(() => tokens.string());
      } else if (field === "sensitivity") {
        tokens.expect("FieldSensitivity");
        tokens.expect("::");
        rule.sensitivity = sensitivityOf(tokens.identifier());
      } else {
        throw new Error(`unexpected SensitivityRule field \`${field}\``);
      }
      if (tokens.peek().value === ",") tokens.next();
    }
    tokens.next();
    if (!rule.path || !rule.sensitivity) throw new Error("incomplete SensitivityRule literal");
    return rule;
  }
  const variant = constructors.get(name);
  if (!variant) throw new Error(`unknown rule constructor \`${name}\``);
  tokens.expect("(");
  const path = tokens.slice(() => tokens.string());
  tokens.expect(")");
  return { path, sensitivity: sensitivityOf(variant) };
}

/** The rule sets the file names as constants (`NONE`, `REDIS_BACKED`). */
function namedRuleSets(source, constructors) {
  const sets = new Map();
  for (const [, name] of source.matchAll(
    /\bconst\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?\[\s*SensitivityRule\s*\]\s*=/g,
  )) {
    const tokens = new TokenStream(source, constantLiteral(source, name));
    sets.set(name, tokens.slice(() => parseRule(tokens, constructors)));
  }
  return sets;
}

/**
 * Edge's `PLUGIN_SENSITIVITY_SCHEMAS`, parsed from the Rust source, as a map
 * from plugin name to its rules. Anything the parser does not recognize —
 * a new rule constructor, a new sensitivity, another literal shape — throws,
 * so the check fails rather than passing over it.
 */
export function parseSensitivitySchemas(source) {
  const constructors = ruleConstructors(source);
  const sets = namedRuleSets(source, constructors);
  const tokens = new TokenStream(source, constantLiteral(source, "PLUGIN_SENSITIVITY_SCHEMAS"));
  const table = new Map();
  for (const [plugin, rules] of tokens.slice(() => {
    tokens.expect("(");
    const plugin = tokens.string();
    tokens.expect(",");
    let rules;
    if (tokens.peek().type === "ident") {
      const name = tokens.identifier();
      rules = sets.get(name);
      if (!rules) throw new Error(`unknown rule set \`${name}\` for \`${plugin}\``);
    } else {
      rules = tokens.slice(() => parseRule(tokens, constructors));
    }
    if (tokens.peek().value === ",") tokens.next();
    tokens.expect(")");
    return [plugin, rules];
  })) {
    if (table.has(plugin)) throw new Error(`\`${plugin}\` appears twice in PLUGIN_SENSITIVITY_SCHEMAS`);
    table.set(plugin, rules);
  }
  return table;
}

/** Edge's `KAFKA_SAFE_PRODUCER_PROPERTIES`, parsed from the Rust source. */
export function parseKafkaSafeProperties(source) {
  const tokens = new TokenStream(source, constantLiteral(source, "KAFKA_SAFE_PRODUCER_PROPERTIES"));
  return new Set(tokens.slice(() => tokens.string()));
}

function ruleKey(rule) {
  return `${rule.sensitivity} ${rule.path.join(".")}`;
}

function ruleKeys(rules) {
  return [...new Set(rules.map(ruleKey))].sort();
}

/** Edge's `normalize_config_key`: case and `-`, `.`, `_` do not distinguish keys. */
function normalizeKey(key) {
  return key.replace(/[-._]/g, "").toLowerCase();
}

function segmentsOverlap(a, b) {
  return a === "*" || b === "*" || normalizeKey(a) === normalizeKey(b);
}

/** The same path, segment for segment, keys compared normalized. */
function samePath(a, b) {
  return (
    a.length === b.length &&
    a.every((segment, index) => normalizeKey(segment) === normalizeKey(b[index]))
  );
}

/**
 * Pairs of one plugin's rules whose order matters. Edge's projection, and the
 * masked-placeholder check that replays it, act on a site the first time a
 * rule reaches it: a rule that withholds a container wholesale hides every
 * site inside it from a later rule, and two different handlings of the same
 * site (`kafka` walks properties, `secret` withholds the object) depend on
 * which runs first. That happens when one rule's path, segment by segment
 * (`*` matching any key, keys compared normalized), is a prefix of another's.
 * A named segment also passes through arrays, so `a.b` and `a.*.b` reach the
 * same elements and are reported even though neither order changes the leaf:
 * that is a harmless false positive. Two equal-length paths are a duplicate,
 * not an ordering, only when they match segment for segment after
 * normalization and the sensitivity is equal; `x.*` against `x.b` differs at
 * a segment, so it is reported.
 */
export function orderDependentRules(rules) {
  const pairs = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const [shorter, longer] = rules[i].path.length <= rules[j].path.length
        ? [rules[i], rules[j]]
        : [rules[j], rules[i]];
      const prefix = shorter.path.every((segment, index) =>
        segmentsOverlap(segment, longer.path[index]));
      if (!prefix) continue;
      // The same site handled the same way is a duplicate, not an ordering.
      if (shorter.sensitivity === longer.sensitivity && samePath(shorter.path, longer.path)) {
        continue;
      }
      pairs.push(`${ruleKey(rules[i])} / ${ruleKey(rules[j])}`);
    }
  }
  return pairs;
}

/**
 * Every difference between Edge's tables and Foundry's. Rules are compared as
 * sets per plugin, which is sound only while no two of a plugin's rules reach
 * overlapping sites: then each site is handled by one rule, whatever the order.
 * Foundry's placeholder check (`src/api/maskedSecretSites.ts`) relies on that,
 * so an Edge table with order-dependent rules is reported too
 * (`orderDependentRules`), and Foundry must then transcribe and compare them
 * in order.
 */
export function compareSensitivity(edge, foundry) {
  const findings = [];
  for (const [plugin, rules] of edge.schemas) {
    const overlapping = orderDependentRules(rules);
    if (overlapping.length > 0) {
      findings.push({ plugin, status: "order-dependent", edge: overlapping, foundry: null });
    }
    const ours = foundry.schemas.get(plugin);
    if (!ours) {
      findings.push({ plugin, status: "missing", edge: ruleKeys(rules), foundry: null });
      continue;
    }
    const expected = ruleKeys(rules);
    const actual = ruleKeys(ours);
    if (expected.join("\n") !== actual.join("\n")) {
      findings.push({ plugin, status: "changed", edge: expected, foundry: actual });
    }
  }
  for (const [plugin, rules] of foundry.schemas) {
    if (!edge.schemas.has(plugin)) {
      findings.push({ plugin, status: "extra", edge: null, foundry: ruleKeys(rules) });
    }
  }
  const missingKafka = [...edge.kafka].filter((property) => !foundry.kafka.has(property));
  const extraKafka = [...foundry.kafka].filter((property) => !edge.kafka.has(property));
  if (missingKafka.length > 0 || extraKafka.length > 0) {
    findings.push({
      plugin: "KAFKA_SAFE_PRODUCER_PROPERTIES",
      status: "changed",
      edge: missingKafka.map((property) => `+ ${property}`),
      foundry: extraKafka.map((property) => `- ${property}`),
    });
  }
  return findings;
}

export function foundryTables() {
  return { schemas: PLUGIN_SENSITIVITY, kafka: KAFKA_SAFE_PRODUCER_PROPERTIES };
}

const TRANSPORT_FAILURE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i;

async function fetchSource(ref) {
  const url =
    `https://raw.githubusercontent.com/${PLUGIN_SENSITIVITY_SOURCE.repository}/` +
    `${ref}/${PLUGIN_SENSITIVITY_SOURCE.path}`;

  // An outage must not be reported as drift, and it must not pass either.
  // Transport failures are retried; an HTTP error is fatal.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const pinned = readSupportedPairing().edge.source_commit;
  const ref = process.env.FERRUM_EDGE_REF?.trim() || pinned;
  const source = await fetchSource(ref);
  const edge = {
    schemas: parseSensitivitySchemas(source),
    kafka: parseKafkaSafeProperties(source),
  };
  const findings = compareSensitivity(edge, foundryTables());
  const provenance = PLUGIN_SENSITIVITY_SOURCE.commit === ref;

  console.log(JSON.stringify({
    ref,
    plugins: edge.schemas.size,
    recorded: PLUGIN_SENSITIVITY_SOURCE.commit,
    findings,
  }, null, 2));

  if (findings.length > 0 || !provenance) {
    console.error(
      `\nsrc/api/pluginSensitivity.ts does not match ${PLUGIN_SENSITIVITY_SOURCE.path} ` +
        `at ${ref}:\n` +
        findings
          .map((finding) =>
            `  ${finding.plugin}: ${finding.status}` +
            (finding.edge ? `\n    edge:    ${finding.edge.join(", ") || "(none)"}` : "") +
            (finding.foundry ? `\n    foundry: ${finding.foundry.join(", ") || "(none)"}` : ""))
          .join("\n") +
        (provenance
          ? ""
          : `\n  PLUGIN_SENSITIVITY_SOURCE.commit is ${PLUGIN_SENSITIVITY_SOURCE.commit}, ` +
            `not the pinned Edge source ${ref}`) +
        "\n\nRe-read Edge's projection table at that commit, bring PLUGIN_SENSITIVITY and " +
        "KAFKA_SAFE_PRODUCER_PROPERTIES in line with it, then record the commit and release " +
        "in PLUGIN_SENSITIVITY_SOURCE. A plugin missing from the table is treated as secret " +
        "throughout; a missing rule lets a value Edge hides from a read come back in a refusal.",
    );
    process.exit(1);
  }
}
