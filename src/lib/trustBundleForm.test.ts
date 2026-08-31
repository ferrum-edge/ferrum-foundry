import { describe, expect, it } from "vitest";
import {
  buildTrustBundlePayload,
  EMPTY_TRUST_BUNDLE_FORM,
  trustBundleToForm,
} from "./trustBundleForm";
import type { GatewayTrustBundle } from "@/api/trust";

describe("buildTrustBundlePayload", () => {
  it("builds a revision-checked local and federated bundle", () => {
    const payload = buildTrustBundlePayload(
      {
        id: "mesh-roots",
        trustDomain: "example.org",
        x509Authorities: "AQID\nBAUG",
        jwtAuthorities: JSON.stringify([
          {
            key_id: "signing-1",
            public_key_pem:
              "-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----",
          },
        ]),
        federatedBundles: JSON.stringify([
          { trust_domain: "partner.example", x509_authorities: ["BwgJ"] },
        ]),
        refreshHintSeconds: "300",
      },
      42,
    );

    expect(payload).toMatchObject({
      id: "mesh-roots",
      trust_domain: "example.org",
      revision: 42,
      bundle: {
        local: {
          trust_domain: "example.org",
          x509_authorities: ["AQID", "BAUG"],
          refresh_hint_seconds: 300,
        },
        federated: [{ trust_domain: "partner.example" }],
      },
    });
  });

  it("rejects missing authorities", () => {
    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
      }),
    ).toThrow("requires at least one");
  });

  it("refuses an edit when the loaded revision would skip concurrency checks", () => {
    const form = {
      ...EMPTY_TRUST_BUNDLE_FORM,
      trustDomain: "example.org",
      x509Authorities: "AQID",
    };
    expect(() => buildTrustBundlePayload(form, 0)).toThrow("no usable revision");
    expect(() => buildTrustBundlePayload(form, -1)).toThrow("no usable revision");
    expect(() => buildTrustBundlePayload(form, 1.5)).toThrow("no usable revision");
    expect(buildTrustBundlePayload(form, 1).revision).toBe(1);
  });

  it("rejects private JWT keys and duplicate key ids", () => {
    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        jwtAuthorities: JSON.stringify([
          {
            key_id: "key-1",
            public_key_pem:
              "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----",
          },
        ]),
      }),
    ).toThrow("must not contain a private key");

    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        jwtAuthorities: JSON.stringify([
          {
            key_id: "symmetric-key",
            public_key_pem: JSON.stringify({ kty: "oct", k: "c2VjcmV0" }),
          },
        ]),
      }),
    ).toThrow("must not contain private or symmetric key material");

    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        jwtAuthorities: JSON.stringify([
          {
            key_id: "partial-private-key",
            public_key_pem: JSON.stringify({ kty: "RSA", n: "abc", e: "AQAB", p: "secret" }),
          },
        ]),
      }),
    ).toThrow("must not contain private or symmetric key material");

    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        jwtAuthorities: JSON.stringify([
          { key_id: "key-1", public_key_pem: '{"kty":"OKP","x":"abc"}' },
          { key_id: "key-1", public_key_pem: '{"kty":"OKP","x":"def"}' },
        ]),
      }),
    ).toThrow("duplicate key_id");
  });

  it("rejects ambiguous trust domains and invalid base64", () => {
    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        x509Authorities: "not base64!",
      }),
    ).toThrow("not valid base64 DER");

    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        x509Authorities: "AQID",
        federatedBundles: JSON.stringify([
          { trust_domain: "example.org", x509_authorities: ["BAUG"] },
        ]),
      }),
    ).toThrow("duplicated");

    expect(() =>
      buildTrustBundlePayload({
        ...EMPTY_TRUST_BUNDLE_FORM,
        trustDomain: "example.org",
        x509Authorities: "AQID",
        federatedBundles: JSON.stringify([
          { trust_domain: "partner.example", x509_authorities: ["AQID"] },
        ]),
      }),
    ).toThrow("ambiguous");
  });
});

describe("trustBundleToForm", () => {
  it("round-trips editable public material without dropping the revision payload", () => {
    const bundle: GatewayTrustBundle = {
      id: "bundle-1",
      namespace: "prod",
      trust_domain: "example.org",
      revision: 99,
      bundle: {
        local: { trust_domain: "example.org", x509_authorities: ["AQID"] },
      },
    };
    expect(buildTrustBundlePayload(trustBundleToForm(bundle), bundle.revision)).toMatchObject({
      id: "bundle-1",
      revision: 99,
      trust_domain: "example.org",
    });
  });
});
