import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowlistDigest,
  compareKinds,
  compareMetricsModes,
  comparePriorities,
  EDGE_SOURCE_TRANSCRIPTIONS,
  edgeSourceParity,
  edgeSourceParityAt,
  parseMetricsModes,
  parseNamespaceScopedKinds,
  parsePluginPriorities,
  parityMarkdown,
  stripRustComments,
} from "./edge-source-parity.mjs";
import { readSupportedPairing } from "./supported-pairing.mjs";
import {
  EDGE_NAMESPACE_SCOPED_KINDS,
  NAMESPACE_SCOPED_ROUTES,
  edgeNamespaceScopedKind,
} from "../server/proxy-path.ts";
import { PLUGIN_DEFAULT_PRIORITY } from "../src/lib/pluginChainOrder.ts";
import { PLUGIN_METADATA } from "../src/lib/pluginConfigDefaults.ts";
import { METRICS_MODES, NO_PROXY_STATE_MODES } from "../src/lib/adminMetricsReporting.ts";

const UNREADABLE_PATTERN = /^unreadable: /;
const ARM_PATTERN = /has an arm the parser does not understand/;
const ENTRY_COUNT_PATTERN = /read 1 of 2 BUILTIN_PLUGIN_PARITY_META entries/;
const MODE_LISTS_PATTERN = /2 `matches!\(\*mode, …\)` mode lists/;

/** Shaped like Edge's `src/plugins/builtin_parity.rs`. */
const PARITY = `
pub struct BuiltinPluginParityMeta {
    pub name: &'static str,
}
pub const BUILTIN_PLUGIN_PARITY_META: &[BuiltinPluginParityMeta] = &[
    BuiltinPluginParityMeta {
        name: "cors",
        classification: BuiltinPluginClassification::Public,
        priority: 100,
        active_phases: "on_request_received, after_proxy [and more]",
        matrix_protocols: HTTP_GRPC_PROTOCOLS,
        protocol_rationale: "a { brace } in prose",
    },
    // BuiltinPluginParityMeta { name: "commented", classification: X::Public, priority: 1, },
    BuiltinPluginParityMeta {
        name: "key_auth",
        classification: BuiltinPluginClassification::Public,
        priority: 1200,
        active_phases: "authenticate",
        matrix_protocols: HTTP_FAMILY_PROTOCOLS,
        protocol_rationale: "",
    },
];
`;

/** Shaped like Edge's `src/admin/mod.rs`. */
const ADMIN = `
/// Docs naming [\`namespace_scoped_resource_kind\`] are not the function.
fn namespace_scoped_resource_kind(segments: &[&str]) -> Option<&'static str> {
    let kind = match *segments.first()? {
        "proxies" => "proxies",
        // a comment between arms
        "config" if segments.get(1) == Some(&"export") => "config-export",
        "plugins" if segments.len() > 1 => "plugins",
        _ => return None,
    };
    Some(kind)
}

fn ceiling_global_route_is_allowed(method: &Method, segments: &[&str]) -> bool {
    (*method == Method::GET && matches!(segments, ["plugins"]))
}

fn ns_claim_global_route_is_allowed(method: &Method, segments: &[&str]) -> bool {
    // The registry handlers authorize the claim themselves.
    ceiling_global_route_is_allowed(method, segments)
        || (*method == Method::POST && matches!(segments, ["namespaces"]))
}

fn unrelated() -> &'static str { r#"{"error":"}"}"# }
`;

const KINDS = [
  { segment: "proxies", guard: null, kind: "proxies", exposed: true },
  { segment: "config", guard: 'segments.get(1)==Some(&"export")', kind: "config-export", exposed: false },
  { segment: "plugins", guard: "segments.len()>1", kind: "plugins", exposed: true },
];
const FUNCTIONS = ["ceiling_global_route_is_allowed", "ns_claim_global_route_is_allowed"];

/** Shaped like Edge's `src/admin/metrics.rs`. */
const METRICS = `
pub const ADMIN_METRICS_MODES: &[&str] = &["database", "file", "cp", "dp", "mesh", "node_agent"];

pub fn contract_fixtures() -> Vec<AdminMetrics> {
    for mode in ADMIN_METRICS_MODES {
        // Modes with proxy state emit populated objects.
        if matches!(*mode, "database" | "file" | "dp" | "mesh") {
            base = proxy_serving_fixture(mode);
        }
    }
}
`;

function foundryFor(admin = ADMIN) {
  return {
    priorities: new Map([["cors", 100], ["key_auth", 1200]]),
    kinds: KINDS,
    routeSource: { allowlistFunctions: FUNCTIONS, allowlistDigest: allowlistDigest(admin, FUNCTIONS) },
    metrics: { modes: ["database", "file", "cp", "dp", "mesh", "node_agent"], noProxyStateModes: ["cp", "node_agent"] },
  };
}

describe("Edge source parity parsers", () => {
  it("reads every source and finds nothing when the tables match", () => {
    assert.deepEqual(edgeSourceParity({ parity: PARITY, admin: ADMIN, metrics: METRICS }, foundryFor()), {
      chainOrder: [],
      namespaceRoutes: [],
      metricsModes: [],
    });
  });

  it("keeps literals while removing comments", () => {
    assert.equal(
      stripRustComments('a // gone\nb /* gone /* nested */ */ "// kept" \'"\' r#"/* kept */"#'),
      'a \nb   "// kept" \'"\' r#"/* kept */"#',
    );
  });

  it("reports a changed, missing or extra default priority", () => {
    const edge = parsePluginPriorities(PARITY.replace("priority: 1200", "priority: 1150"));
    assert.deepEqual(comparePriorities(edge, new Map([["cors", 100], ["key_auth", 1200], ["gone", 5]])), [
      "plugin `key_auth` has priority 1150, Foundry records 1200",
      "plugin `gone` is no longer a built-in",
    ]);
    assert.deepEqual(comparePriorities(parsePluginPriorities(PARITY), new Map([["cors", 100]])), [
      "plugin `key_auth` (priority 1200) is missing",
    ]);
  });

  it("refuses a parity entry it cannot read rather than skip it", () => {
    const reordered = PARITY.replace(
      'name: "key_auth",\n        classification: BuiltinPluginClassification::Public,',
      'classification: BuiltinPluginClassification::Public,\n        name: "key_auth",',
    );
    assert.throws(() => parsePluginPriorities(reordered), ENTRY_COUNT_PATTERN);
    const result = edgeSourceParity({ parity: reordered, admin: ADMIN, metrics: METRICS }, foundryFor());
    assert.match(result.chainOrder[0], UNREADABLE_PATTERN);
  });

  it("reads match arms in order, guards without whitespace", () => {
    assert.deepEqual(
      parseNamespaceScopedKinds(ADMIN),
      KINDS.map(({ segment, guard, kind }) => ({ segment, guard, kind })),
    );
  });

  it("reports a narrowed, added or removed arm", () => {
    const narrowed = ADMIN.replace(
      '"config" if segments.get(1) == Some(&"export")',
      '"config" if segments == ["config", "export"]',
    ).replace('"proxies" => "proxies",', '"proxies" => "proxies",\n        "batch" => "batch",');
    assert.deepEqual(compareKinds(parseNamespaceScopedKinds(narrowed), KINDS), [
      'namespace_scoped_resource_kind arm 2 is "batch" => "batch"; Foundry records "config" if segments.get(1)==Some(&"export") => "config-export"',
      'namespace_scoped_resource_kind arm 3 is "config" if segments==["config","export"] => "config-export"; Foundry records "plugins" if segments.len()>1 => "plugins"',
      'namespace_scoped_resource_kind arm 4 is "plugins" if segments.len()>1 => "plugins"; Foundry records nothing',
    ]);
  });

  it("refuses an arm shape it does not understand", () => {
    const computed = ADMIN.replace('"proxies" => "proxies",', 'other if other.starts_with("p") => "proxies",');
    assert.throws(() => parseNamespaceScopedKinds(computed), ARM_PATTERN);
  });

  it("ignores formatting and comments in the allowlists but not a changed route", () => {
    const reformatted = ADMIN.replace(
      "    (*method == Method::GET && matches!(segments, [\"plugins\"]))",
      "    // reformatted\n    (*method == Method::GET\n        && matches!(segments, [\"plugins\"]))",
    );
    assert.equal(allowlistDigest(reformatted, FUNCTIONS), allowlistDigest(ADMIN, FUNCTIONS));
    const widened = ADMIN.replace('["namespaces"]))', '["namespaces"] | ["overload"]))');
    const result = edgeSourceParity({ parity: PARITY, admin: widened, metrics: METRICS }, foundryFor());
    assert.equal(result.namespaceRoutes.length, 1);
    assert.match(result.namespaceRoutes[0], /ceiling_global_route_is_allowed \/ ns_claim_global_route_is_allowed changed/);
  });

  it("derives the placeholder modes and reports a mode either side lacks", () => {
    assert.deepEqual(parseMetricsModes(METRICS), {
      modes: ["database", "file", "cp", "dp", "mesh", "node_agent"],
      servingModes: ["database", "file", "dp", "mesh"],
      noProxyStateModes: ["cp", "node_agent"],
    });
    const added = parseMetricsModes(METRICS.replace('"node_agent"]', '"node_agent", "edge_agent"]'));
    assert.deepEqual(compareMetricsModes(added, foundryFor().metrics), [
      "gateway modes Foundry does not name: edge_agent",
      "modes Edge answers with placeholders that Foundry shows as measured: edge_agent",
    ]);
    const serving = parseMetricsModes(METRICS.replace('"dp" | "mesh"', '"dp" | "mesh" | "cp"'));
    assert.deepEqual(compareMetricsModes(serving, foundryFor().metrics), [
      "modes Foundry hides although Edge measures them: cp",
    ]);
    const twice = METRICS.replace("base = proxy_serving_fixture(mode);", 'if matches!(*mode, "cp") {}');
    assert.throws(() => parseMetricsModes(twice), MODE_LISTS_PATTERN);
  });

  it("fetches the three files at one ref and words each finding", async () => {
    const fetched = [];
    const result = await edgeSourceParityAt("0123456789abcdef0123456789abcdef01234567", {
      fetchSource: async (source, ref) => {
        fetched.push([source.path, ref]);
        return { "src/plugins/builtin_parity.rs": PARITY, "src/admin/mod.rs": ADMIN, "src/admin/metrics.rs": METRICS }[source.path];
      },
    });
    assert.deepEqual(fetched.map(([path]) => path).sort(), [
      "src/admin/metrics.rs",
      "src/admin/mod.rs",
      "src/plugins/builtin_parity.rs",
    ]);
    assert.ok(fetched.every(([, ref]) => ref === "0123456789abcdef0123456789abcdef01234567"));
    // The real Foundry tables do not match these small fixtures.
    assert.ok(parityMarkdown(result).length > 0);
  });
});

describe("Foundry's Edge source transcriptions", () => {
  it("record the pinned Edge source commit", () => {
    const pinned = readSupportedPairing().edge.source_commit;
    for (const { source, file } of EDGE_SOURCE_TRANSCRIPTIONS) {
      assert.equal(source.commit, pinned, `${file} records ${source.commit}`);
    }
  });

  it("give every plugin in Foundry's catalog a default priority", () => {
    const missing = Object.keys(PLUGIN_METADATA).filter((name) => !PLUGIN_DEFAULT_PRIORITY.has(name));
    assert.deepEqual(missing, []);
  });

  it("let a scoped principal reach only route classes Edge treats as namespace-scoped", () => {
    // One concrete path per NAMESPACE_SCOPED_ROUTES entry.
    const samples = [
      ["GET", "/proxies"], ["POST", "/upstreams"], ["GET", "/consumers"], ["GET", "/plugins/config"],
      ["GET", "/api-specs"], ["GET", "/gateway-trust-bundles"], ["PUT", "/proxies/p1"],
      ["DELETE", "/plugins/config/c1"], ["POST", "/consumers/c1/credentials/keyauth"],
      ["DELETE", "/consumers/c1/credentials/keyauth/0"], ["GET", "/api-specs/by-proxy/p1"],
      ["GET", "/proxies/p1/mcp/tools"], ["GET", "/gateway-trust/status"], ["GET", "/audit"],
      ["POST", "/restore"], ["GET", "/backup"],
    ];
    const listed = (method, path) =>
      NAMESPACE_SCOPED_ROUTES.some(([methods, pattern]) => methods.split("|").includes(method) && pattern.test(path));
    for (const [, pattern] of NAMESPACE_SCOPED_ROUTES) {
      assert.ok(samples.some(([, path]) => pattern.test(path)), `no sample for ${pattern}`);
    }
    for (const [method, path] of samples) {
      assert.ok(listed(method, path), `${method} ${path} is not listed`);
      assert.equal(edgeNamespaceScopedKind(path)?.exposed, true, `${path} is not an exposed Edge kind`);
    }
    // Every kind the BFF withholds stays out of the route list.
    const withheld = { batch: "/batch", "deployment-snapshot": "/deployment-snapshot",
      "backend-egress-policy": "/backend-egress-policy", "config-export": "/config/export" };
    for (const arm of EDGE_NAMESPACE_SCOPED_KINDS.filter((entry) => !entry.exposed)) {
      const path = withheld[arm.kind];
      assert.ok(path, `no sample for withheld kind ${arm.kind}`);
      assert.equal(edgeNamespaceScopedKind(path), arm);
      for (const method of ["GET", "POST", "PUT", "DELETE"]) assert.equal(listed(method, path), false);
    }
    // Split as Edge splits: a trailing slash is an empty segment.
    assert.equal(edgeNamespaceScopedKind("/plugins"), undefined);
    assert.equal(edgeNamespaceScopedKind("/plugins/")?.kind, "plugins");
    assert.equal(edgeNamespaceScopedKind("/config/apply-status"), undefined);
  });

  it("name every gateway mode, and the placeholder modes among them", () => {
    assert.ok(NO_PROXY_STATE_MODES.every((mode) => METRICS_MODES.includes(mode)));
  });
});
