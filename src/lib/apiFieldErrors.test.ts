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

  it.each([
    [
      "cert_pem and key_pem do not form a valid pair: keys may not be consistent: KeyMismatch",
      {
        field: "cert_pem",
        message: "Keys may not be consistent: KeyMismatch",
        fields: ["cert_pem", "key_pem"],
      },
    ],
    [
      "ocsp_der_base64 must be valid base64: Invalid symbol 32, offset 7.",
      { field: "ocsp_der_base64", message: "Invalid symbol 32, offset 7." },
    ],
    [
      "jwks_json must be valid JSON: expected value at line 1 column 1",
      { field: "jwks_json", message: "Expected value at line 1 column 1" },
    ],
  ] as const)("parses the Edge v0.9.9 TLS validation detail %s", (detail, expected) => {
    expect(parseFieldError(detail, TLS_FIELDS)).toEqual(expected);
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
