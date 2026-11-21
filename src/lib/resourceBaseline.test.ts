import { describe, expect, it } from "vitest";
import type { PluginTriggerMatch } from "@/api/types";
import {
  baselineSnapshot,
  canonicalize,
  compareBaselines,
  formatBaselineValue,
  isRedactedField,
  pickSnapshot,
  pluginTriggerWithheldSites,
  PROXY_BASELINE_OMIT,
  TRIGGER_CLIENT_FIELD_PREDICATES,
  TRIGGER_VISIBLE_PREDICATES,
  resourceFingerprint,
  UPSTREAM_BASELINE_OMIT,
} from "./resourceBaseline";

describe("canonicalization", () => {
  it("makes key order irrelevant at every depth", () => {
    const a = { z: 1, nested: { b: 2, a: [{ y: 1, x: 2 }] } };
    const b = { nested: { a: [{ x: 2, y: 1 }], b: 2 }, z: 1 };
    expect(resourceFingerprint(a)).toBe(resourceFingerprint(b));
  });

  it("keeps array order, which is meaningful in every replaced field", () => {
    const first = { targets: [{ host: "a" }, { host: "b" }] };
    const second = { targets: [{ host: "b" }, { host: "a" }] };
    expect(resourceFingerprint(first)).not.toBe(resourceFingerprint(second));
  });

  it("distinguishes an explicit null from an absent key", () => {
    expect(resourceFingerprint({ name: null })).not.toBe(resourceFingerprint({}));
  });

  it("treats an undefined value and an absent key as the same request bytes", () => {
    expect(resourceFingerprint({ name: undefined })).toBe(resourceFingerprint({}));
  });

  it("leaves primitives and null alone", () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(7)).toBe(7);
    expect(canonicalize("x")).toBe("x");
  });
});

describe("baseline reduction", () => {
  const proxy = {
    id: "checkout",
    namespace: "tenant-a",
    backend_host: "a.internal",
    backend_port: 8443,
    plugins: [{ plugin_config_id: "rate-limit" }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    api_spec_id: null,
  };

  it("drops server-managed fields so an unrelated write is not a conflict", () => {
    const before = baselineSnapshot(proxy, PROXY_BASELINE_OMIT);
    const after = baselineSnapshot(
      { ...proxy, updated_at: "2026-03-03T00:00:00Z" },
      PROXY_BASELINE_OMIT,
    );
    expect(resourceFingerprint(before)).toBe(resourceFingerprint(after));
    expect(Object.keys(before)).not.toContain("updated_at");
  });

  it("drops proxy plugin associations, which a proxy save never replaces", () => {
    const detached = baselineSnapshot({ ...proxy, plugins: [] }, PROXY_BASELINE_OMIT);
    expect(resourceFingerprint(baselineSnapshot(proxy, PROXY_BASELINE_OMIT)))
      .toBe(resourceFingerprint(detached));
  });

  it("still reacts to a field the write does replace", () => {
    const moved = baselineSnapshot(
      { ...proxy, backend_host: "b.internal" },
      PROXY_BASELINE_OMIT,
    );
    expect(resourceFingerprint(baselineSnapshot(proxy, PROXY_BASELINE_OMIT)))
      .not.toBe(resourceFingerprint(moved));
  });

  it("drops mesh-projected upstream fields the control plane owns", () => {
    const upstream = {
      id: "payments",
      algorithm: "round_robin",
      targets: [],
      source_locality: "us-east-1a",
      locality_lb_strict: false,
      port_overrides: { "8080": 9090 },
    };
    const snapshot = baselineSnapshot(upstream, UPSTREAM_BASELINE_OMIT);
    expect(Object.keys(snapshot).sort()).toEqual(["algorithm", "id", "targets"]);
  });

  it("selects a single field for a write that replaces only that field", () => {
    const upstream = { id: "payments", algorithm: "round_robin", targets: [{ host: "a" }] };
    expect(pickSnapshot(upstream, ["targets"])).toEqual({ targets: [{ host: "a" }] });
  });
});

describe("three-way comparison", () => {
  const original = { backend_host: "a.internal", read_timeout: 5, name: "checkout" };

  it("keeps only fields someone changed", () => {
    const current = { ...original, backend_host: "b.internal" };
    const proposed = { ...original, read_timeout: 30 };
    const differences = compareBaselines(original, current, proposed);

    expect(differences.map((d) => d.field)).toEqual(["backend_host", "read_timeout"]);
    expect(differences[0]).toMatchObject({
      field: "backend_host",
      changedUpstream: true,
      changedLocally: false,
      current: "b.internal",
    });
    expect(differences[1]).toMatchObject({
      field: "read_timeout",
      changedUpstream: false,
      changedLocally: true,
      proposed: 30,
    });
  });

  it("marks a field both sides moved", () => {
    const differences = compareBaselines(
      original,
      { ...original, name: "checkout-eu" },
      { ...original, name: "checkout-us" },
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ changedUpstream: true, changedLocally: true });
  });

  it("does not report an omitted optional against an explicit clear", () => {
    // `mergeFormUpdatePayload` spells clears out as null; a gateway response
    // simply omits the key. That is the same instruction, not a difference.
    expect(compareBaselines({ id: "x" }, { id: "x" }, { id: "x", name: null })).toEqual([]);
  });
});

describe("redaction", () => {
  it("recognises credential-shaped field names", () => {
    for (const field of [
      "api_key",
      "password",
      "hmac_secret",
      "jwt_token",
      "ca_certificate_pem",
      "signing_key",
      "key",
    ]) {
      expect(isRedactedField(field), field).toBe(true);
    }
    expect(isRedactedField("backend_host")).toBe(false);
    expect(isRedactedField("read_timeout")).toBe(false);
    // A boolean flag that merely mentions certificates carries no material.
    expect(isRedactedField("backend_tls_verify_server_cert")).toBe(false);
  });

  it("shows a path to material, which is not the material", () => {
    expect(isRedactedField("backend_tls_client_key_path")).toBe(false);
    expect(formatBaselineValue("backend_tls_client_key_path", "/etc/ferrum/client.key"))
      .toBe("/etc/ferrum/client.key");
    expect(formatBaselineValue("backend_tls_client_key_path", "k8s://tenant-a/tls/client"))
      .toBe("k8s://tenant-a/tls/client");
    expect(formatBaselineValue("backend_tls_server_ca_cert_path", "system://"))
      .toBe("system://");
  });

  it("hides inline PEM material in a path field, but shows that it moved (#612)", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7syntheticAAAA",
      "c3ludGhldGljLXByaXZhdGUta2V5LW1hdGVyaWFsLWZvci10ZXN0cy1vbmx5BBBB",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    for (const field of [
      "backend_tls_client_key_path",
      "backend_tls_client_cert_path",
      "backend_tls_server_ca_cert_path",
    ]) {
      const rendered = formatBaselineValue(field, pem);
      expect(rendered, field).toBe("[redacted]");
      expect(rendered).not.toContain(pem.split("\n")[1]);
      expect(rendered).not.toContain(pem.split("\n")[2]);
    }
    const damaged = pem.replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY----");
    expect(formatBaselineValue("backend_tls_client_key_path", damaged)).toBe("[redacted]");
    expect(formatBaselineValue("backend_tls_client_key_path", `  ${damaged}`)).toBe("[redacted]");
    expect(formatBaselineValue("backend_tls_client_key_path", null)).toBe("null");
    expect(formatBaselineValue("backend_tls_client_key_path", "")).toBe('""');

    const nested = formatBaselineValue("tls", {
      private_key_path: pem,
      ca_cert_path: "/etc/ferrum/ca.pem",
    });
    expect(nested).not.toContain(pem.split("\n")[1]);
    expect(JSON.parse(nested)).toEqual({
      private_key_path: "[redacted]",
      ca_cert_path: "/etc/ferrum/ca.pem",
    });
  });

  it("hides a redacted value but still shows that it moved", () => {
    expect(formatBaselineValue("api_key", "sk-live-1234")).toBe("[redacted]");
    expect(formatBaselineValue("api_key", null)).toBe("null");
    expect(formatBaselineValue("api_key", undefined)).toBe("—");
  });

  it("redacts a plugin configuration's own secrets, including request headers", () => {
    // A plugin's `config` is one top-level field holding the plugin's own
    // settings; an upstream `Authorization` header is not a key-shaped name.
    const rendered = formatBaselineValue("config", {
      algorithm: "HS256",
      secret: "jwt-signing-secret",
      upstream_headers: { Authorization: "Bearer abc", Cookie: "session=1", "X-Trace": "on" },
      cleared_token: null,
    });
    expect(rendered).not.toContain("jwt-signing-secret");
    expect(rendered).not.toContain("Bearer abc");
    expect(rendered).not.toContain("session=1");
    expect(JSON.parse(rendered)).toEqual({
      algorithm: "HS256",
      secret: "[redacted]",
      upstream_headers: { Authorization: "[redacted]", Cookie: "[redacted]", "X-Trace": "on" },
      cleared_token: null,
    });
  });

  it("recursively hides credentials in nested objects and arrays", () => {
    const rendered = formatBaselineValue("service_discovery", {
      consul: {
        address: "http://consul.internal:8500",
        token: "CONSUL_SECRET",
        nested: [{ api_key: "NESTED_SECRET" }],
      },
    });

    expect(JSON.parse(rendered)).toEqual({
      consul: {
        address: "http://consul.internal:8500",
        token: "[redacted]",
        nested: [{ api_key: "[redacted]" }],
      },
    });
    expect(rendered).not.toContain("CONSUL_SECRET");
    expect(rendered).not.toContain("NESTED_SECRET");
  });

  it("preserves nested material paths while redacting nearby material", () => {
    expect(JSON.parse(formatBaselineValue("tls", {
      private_key_path: "/etc/ferrum/client.key",
      private_key: "PRIVATE_KEY_BYTES",
    }))).toEqual({
      private_key_path: "/etc/ferrum/client.key",
      private_key: "[redacted]",
    });
  });

  it("renders ordinary values readably", () => {
    expect(formatBaselineValue("backend_host", "a.internal")).toBe("a.internal");
    expect(formatBaselineValue("hosts", ["a", "b"])).toBe('["a","b"]');
    expect(formatBaselineValue("name", "")).toBe('""');
  });
});

describe("plugin trigger redaction (Edge main's trigger projection)", () => {
  const HEADER_TOKEN = "synthetic-header-bypass-token";
  const QUERY_PREFIX = "synthetic-query-prefix";
  const COOKIE_PATTERN = "synthetic-cookie-[a-z]+";
  const trigger = {
    when: {
      all: [
        { not: { match: { header: { name: "x-skip-waf", value: { exact: [HEADER_TOKEN, "second"] } } } } },
        { match: { query: { name: "debug", multi_value: "any", value: { prefix: [QUERY_PREFIX] } } } },
        { match: { cookie: { name: "canary", value: { regex: COOKIE_PATTERN, case_insensitive: true } } } },
        { match: { path: { prefix: ["/internal"] } } },
        { match: { method: ["POST"] } },
        { match: { consumer: { value: { exact: ["orders-svc"] } } } },
        { match: { external_identity: { presence: "present" } } },
        { match: { external_identity_authority: ["ab".repeat(32)] } },
      ],
    },
  };

  it("classifies every PluginTriggerMatch field as client-presented or visible, and nothing else", () => {
    // A field added to the type without a classification would be withheld
    // wholesale by the walk; one dropped from it would leave a stale entry.
    const fields: Record<keyof PluginTriggerMatch, true> = {
      method: true,
      path: true,
      host: true,
      sni: true,
      header: true,
      query: true,
      cookie: true,
      protocol: true,
      source_cidr: true,
      namespace: true,
      proxy_id: true,
      listen_port: true,
      consumer: true,
      external_identity: true,
      external_identity_authority: true,
      auth_method: true,
      spiffe_id: true,
    };
    expect([...TRIGGER_CLIENT_FIELD_PREDICATES, ...TRIGGER_VISIBLE_PREDICATES].sort()).toEqual(
      Object.keys(fields).sort(),
    );
  });

  it("withholds each header, query and cookie operand, by JSON pointer", () => {
    expect(pluginTriggerWithheldSites(trigger)).toEqual([
      { pointer: "/trigger/when/all/0/not/match/header/value/exact/0", value: HEADER_TOKEN },
      { pointer: "/trigger/when/all/0/not/match/header/value/exact/1", value: "second" },
      { pointer: "/trigger/when/all/1/match/query/value/prefix/0", value: QUERY_PREFIX },
      { pointer: "/trigger/when/all/2/match/cookie/value/regex", value: COOKIE_PATTERN },
    ]);
  });

  it("fails closed on shapes a PluginTrigger cannot have", () => {
    const pointers = (value: unknown) => pluginTriggerWithheldSites(value).map((site) => site.pointer);
    expect(pointers(null)).toEqual([]);
    expect(pointers("anything")).toEqual(["/trigger"]);
    expect(pointers({ match: {} })).toEqual(["/trigger"]);
    expect(pointers({ when: { match: { path: { exact: ["/"] } } }, extra: 1 })).toEqual([
      "/trigger/extra",
    ]);
    expect(pointers({ when: [] })).toEqual(["/trigger/when"]);
    expect(pointers({ when: { any: {} } })).toEqual(["/trigger/when/any"]);
    expect(pointers({ when: { match: { "head/er~": "x" } } })).toEqual([
      "/trigger/when/match/head~1er~0",
    ]);
    expect(pointers({ when: { match: { header: { name: "x", value: "v", extra: "e" } } } })).toEqual([
      "/trigger/when/match/header/value",
      "/trigger/when/match/header/extra",
    ]);
    expect(pointers({ when: { match: { query: { name: "q", value: { case_insensitive: "yes" } } } } }))
      .toEqual(["/trigger/when/match/query/value/case_insensitive"]);
    // An explicit null discloses nothing and is not a site.
    expect(pointers({ when: { match: { header: { name: "x", value: { regex: null } } } } })).toEqual([]);
  });

  it("formatBaselineValue shows the trigger's shape and visible predicates, never an operand", () => {
    const shown = formatBaselineValue("trigger", trigger);
    for (const operand of [HEADER_TOKEN, "second", QUERY_PREFIX, COOKIE_PATTERN]) {
      expect(shown).not.toContain(operand);
    }
    expect(shown).toContain("[redacted]");
    for (const visible of ["x-skip-waf", "debug", "/internal", "POST", "orders-svc", "ab".repeat(32)]) {
      expect(shown).toContain(visible);
    }
    // A header operand change still shows as a change, without its value.
    const changed = structuredClone(trigger);
    changed.when.all[0].not!.match.header!.value.exact[0] = "synthetic-replacement-token";
    const differences = compareBaselines({ trigger }, { trigger: changed }, { trigger });
    expect(differences.map((difference) => difference.field)).toEqual(["trigger"]);
    expect(formatBaselineValue("trigger", changed)).not.toContain("synthetic-replacement-token");
  });

  it("formatBaselineValue withholds a malformed trigger whole and keeps null distinct", () => {
    expect(formatBaselineValue("trigger", "synthetic-raw-string")).toBe("[redacted]");
    expect(formatBaselineValue("trigger", { if: { header: "synthetic-raw" } })).not.toContain(
      "synthetic-raw",
    );
    expect(formatBaselineValue("trigger", null)).toBe("null");
    expect(formatBaselineValue("trigger", undefined)).toBe("—");
  });
});
