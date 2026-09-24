import { describe, expect, it } from "vitest";
import {
  baselineSnapshot,
  canonicalize,
  compareBaselines,
  formatBaselineValue,
  isRedactedField,
  pickSnapshot,
  PROXY_BASELINE_OMIT,
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
