/* ------------------------------------------------------------------ */
/*  Edge main's TLS-source and path classes in failed-write redaction */
/* ------------------------------------------------------------------ */

/**
 * Ferrum Edge `main` (ferrum-edge#7054, after v0.9.20) adds
 * `FieldSensitivity::CertificateSource`, `PrivateKeySource` and
 * `EndpointPath`. Foundry's table stays at the pinned v0.9.20, which has no
 * such rules, so this file swaps in Edge main's rules for the plugins that use
 * them and checks that a failed write keeps back exactly what an Edge `main`
 * non-admin read withholds.
 */

import { describe, expect, it, vi } from "vitest";
import type { SensitivityRule } from "./pluginSensitivity";
import { pluginConfigSecrets, type Secrets } from "./secretRedaction";

vi.mock("./pluginSensitivity", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pluginSensitivity")>();
  const rule = (sensitivity: SensitivityRule["sensitivity"], ...path: string[]) => ({
    path,
    sensitivity,
  });
  // Edge main's rules, as `plugin_config_projection.rs` declares them.
  const edgeMain = new Map<string, readonly SensitivityRule[]>([
    ["mtls_auth", [rule("certificate", "allowed_issuers", "*", "ca_certificate_pem")]],
    ["soap_ws_security", [
      rule("certificate", "x509_signature", "trusted_certs", "*"),
      rule("certificate", "saml", "trusted_signing_certs", "*"),
    ]],
    ["udp_logging", [
      rule("private-key", "dtls_key_path"),
      rule("certificate", "dtls_cert_path"),
      rule("certificate", "dtls_ca_cert_path"),
    ]],
    ["request_mirror", [rule("endpoint-path", "mirror_path")]],
  ]);
  return {
    ...original,
    PLUGIN_SENSITIVITY: new Map([...original.PLUGIN_SENSITIVITY, ...edgeMain]),
  };
});

const KEY = [
  "-----BEGIN EC PRIVATE KEY-----",
  "c3ludGhldGljLXByaXZhdGUta2V5LW1hdGVyaWFsLWZvci10ZXN0cy1vbmx5BBBB",
  "-----END EC PRIVATE KEY-----",
].join("\n");
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBsyntheticcertificate\n-----END CERTIFICATE-----";
const BUNDLE = `${CERT}\n${KEY}`;

function classifiedValues(secrets: Secrets): string[] {
  expect(secrets.tokens).toEqual([]);
  return [...secrets.values].sort();
}

// Foundry's own floor is wider than Edge's for some of these fields: it takes
// any `*_pem` or `*signature*` field whole, inline PEM in any `*_path` field,
// and the path of any absolute URL. The cases below use values only the new
// classes decide.
describe("certificate sources (CertificateSource)", () => {
  it("keep certificate-only PEM and references readable, and take a certificate-plus-key bundle", () => {
    expect(classifiedValues(pluginConfigSecrets("soap_ws_security", {
      saml: { trusted_signing_certs: ["/etc/ferrum/idp.pem", CERT, BUNDLE] },
    }))).toEqual([BUNDLE]);
  });

  it("fail closed on a value that is not a string", () => {
    expect(classifiedValues(pluginConfigSecrets("soap_ws_security", {
      saml: { trusted_signing_certs: [{ pem: "nested-material-1" }] },
    }))).toEqual(["nested-material-1"]);
  });
});

describe("private-key sources (PrivateKeySource)", () => {
  it("keep a reference readable and take key material or a control character", () => {
    expect(classifiedValues(pluginConfigSecrets("udp_logging", {
      dtls_key_path: "/etc/ferrum/dtls.key",
      dtls_cert_path: "/etc/ferrum/dtls.crt",
      dtls_ca_cert_path: "system://",
    }))).toEqual([]);
    expect(classifiedValues(pluginConfigSecrets("udp_logging", { dtls_key_path: KEY })))
      .toEqual([KEY]);
    // A control character is never part of a path or reference.
    const control = "/etc/ferrum/dtls\u0007.key";
    expect(classifiedValues(pluginConfigSecrets("udp_logging", { dtls_key_path: control })))
      .toEqual([control]);
    expect(classifiedValues(pluginConfigSecrets("udp_logging", { dtls_cert_path: control })))
      .toEqual([]);
  });
});

describe("destination paths (EndpointPath)", () => {
  it("keep an empty or root path readable and take any other path", () => {
    expect(classifiedValues(pluginConfigSecrets("request_mirror", { mirror_path: "/" }))).toEqual([]);
    expect(classifiedValues(pluginConfigSecrets("request_mirror", { mirror_path: "" }))).toEqual([]);
    expect(classifiedValues(pluginConfigSecrets("request_mirror", {
      mirror_host: "shadow.internal",
      mirror_path: "/ingest/tok-123",
    }))).toEqual(["/ingest/tok-123"]);
  });
});

describe("the TLS-material layer", () => {
  it("takes a PEM private-key block in any field of a known plugin", () => {
    expect(classifiedValues(pluginConfigSecrets("stdout_logging", { note: BUNDLE, level: "info" })))
      .toEqual([BUNDLE]);
    expect(classifiedValues(pluginConfigSecrets("stdout_logging", { note: CERT }))).toEqual([]);
  });
});
