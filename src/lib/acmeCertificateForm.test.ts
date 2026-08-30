import { describe, expect, it } from "vitest";
import {
  buildAcmeCertificateRequest,
  EMPTY_ACME_CERTIFICATE_FORM,
} from "./acmeCertificateForm";

const CERT = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----";

describe("buildAcmeCertificateRequest", () => {
  it("builds a canonical request and deduplicates domains", () => {
    expect(
      buildAcmeCertificateRequest({
        ...EMPTY_ACME_CERTIFICATE_FORM,
        id: "edge-cert",
        domains: "example.com, www.example.com, example.com",
        certPem: CERT,
        keyPem: KEY,
      }),
    ).toMatchObject({
      id: "edge-cert",
      domains: ["example.com", "www.example.com"],
      directory_url: "https://acme-v02.api.letsencrypt.org/directory",
      cert_pem: CERT,
      key_pem: KEY,
      cert_expiry_warning_days: 30,
    });
  });

  it.each([
    ["http://ca.example/directory", "absolute HTTPS"],
    ["https://user:pass@ca.example/directory", "without credentials"],
    ["https://ca.example/directory#fragment", "without credentials"],
  ])("rejects unsafe directory URL %s", (directoryUrl, message) => {
    expect(() =>
      buildAcmeCertificateRequest({
        ...EMPTY_ACME_CERTIFICATE_FORM,
        domains: "example.com",
        directoryUrl,
        certPem: CERT,
        keyPem: KEY,
      }),
    ).toThrow(message);
  });

  it("rejects missing or wrong certificate/key material", () => {
    expect(() =>
      buildAcmeCertificateRequest({
        ...EMPTY_ACME_CERTIFICATE_FORM,
        domains: "example.com",
        certPem: "not pem",
        keyPem: KEY,
      }),
    ).toThrow("complete CERTIFICATE PEM");
    expect(() =>
      buildAcmeCertificateRequest({
        ...EMPTY_ACME_CERTIFICATE_FORM,
        domains: "example.com",
        certPem: CERT,
        keyPem: "-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----",
      }),
    ).toThrow("Private key must be complete");
  });
});
