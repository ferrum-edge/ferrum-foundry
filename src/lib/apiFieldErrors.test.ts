import { describe, expect, it } from "vitest";
import { parseFieldError } from "./apiFieldErrors";

const TLS_FIELDS = [
  "cert_pem",
  "key_pem",
  "chain_pem",
  "ca_bundle_pem",
  "crl_pem",
  "ocsp_der_base64",
  "jwks_json",
];

describe("parseFieldError", () => {
  it("splits the gateway's field-scoped 400 detail and sentence-cases it", () => {
    expect(
      parseFieldError("cert_pem: no PEM certificates found", TLS_FIELDS),
    ).toEqual({ field: "cert_pem", message: "No PEM certificates found" });
  });

  it("leaves the rest of the message untouched", () => {
    expect(
      parseFieldError(
        "jwks_json: expected a JSON object with a \"keys\" array",
        TLS_FIELDS,
      ),
    ).toEqual({
      field: "jwks_json",
      message: 'Expected a JSON object with a "keys" array',
    });
  });

  it("keeps colons that belong to the message", () => {
    expect(
      parseFieldError("key_pem: key does not match cert_pem: mismatch", TLS_FIELDS),
    ).toEqual({
      field: "key_pem",
      message: "Key does not match cert_pem: mismatch",
    });
  });

  it("tolerates whitespace around the field and the message", () => {
    expect(
      parseFieldError("  ca_bundle_pem  :   no PEM certificates found  ", TLS_FIELDS),
    ).toEqual({
      field: "ca_bundle_pem",
      message: "No PEM certificates found",
    });
  });

  it("returns null when the prefix is not a known field", () => {
    expect(parseFieldError("bad request: try again", TLS_FIELDS)).toBeNull();
    expect(
      parseFieldError("cert_pem: no PEM certificates found", ["jwks_json"]),
    ).toBeNull();
  });

  it("returns null without a colon, an empty detail, or an empty message", () => {
    expect(parseFieldError("no PEM certificates found", TLS_FIELDS)).toBeNull();
    expect(parseFieldError("", TLS_FIELDS)).toBeNull();
    expect(parseFieldError("cert_pem:   ", TLS_FIELDS)).toBeNull();
    expect(parseFieldError(": no PEM certificates found", TLS_FIELDS)).toBeNull();
  });

  it("does not sentence-case a message that starts with a non-letter", () => {
    expect(parseFieldError("crl_pem: 3 entries rejected", TLS_FIELDS)).toEqual({
      field: "crl_pem",
      message: "3 entries rejected",
    });
  });
});
