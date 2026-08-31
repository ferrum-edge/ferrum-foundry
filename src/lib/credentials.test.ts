import { describe, expect, it } from "vitest";
import { buildCredentialInput } from "./credentials";

describe("buildCredentialInput", () => {
  it("requires an explicit non-redacted key without changing its bytes", () => {
    expect(() => buildCredentialInput("keyauth", { key: "" })).toThrow("1-4096");
    expect(() => buildCredentialInput("keyauth", { key: "   " })).toThrow("whitespace");
    expect(() => buildCredentialInput("keyauth", { key: "[REDACTED]" })).toThrow("reserved");
    expect(buildCredentialInput("keyauth", { key: " leading-and-trailing " })).toEqual({
      key: " leading-and-trailing ",
    });
  });

  it("builds Basic Auth with exactly one canonical password field", () => {
    expect(buildCredentialInput("basicauth", {
      username: "must-not-leak",
      password: " exact password ",
    })).toEqual({ password: " exact password " });
    expect(buildCredentialInput("basicauth", {
      password_hash: `hmac_sha256:${"a".repeat(64)}`,
    })).toEqual({ password_hash: `hmac_sha256:${"a".repeat(64)}` });
    expect(() => buildCredentialInput("basicauth", {
      password: "password",
      password_hash: `hmac_sha256:${"a".repeat(64)}`,
    })).toThrow("either");
  });

  it.each([
    ["jwt", 31, false],
    ["jwt", 32, true],
    ["jwt", 4096, true],
    ["jwt", 4097, false],
    ["hmac_auth", 31, false],
    ["hmac_auth", 32, true],
    ["hmac_auth", 4096, true],
    ["hmac_auth", 4097, false],
  ] as const)("enforces %s length boundary %i", (type, length, valid) => {
    const action = () => buildCredentialInput(type, { secret: "x".repeat(length) });
    if (valid) expect(action).not.toThrow();
    else expect(action).toThrow("32-4096");
  });

  it("requires 32 non-whitespace HMAC characters", () => {
    expect(() => buildCredentialInput("hmac_auth", {
      secret: `${"x".repeat(31)}${" ".repeat(32)}`,
    })).toThrow("non-whitespace");
  });

  it.each(["keyauth", "basicauth", "jwt", "hmac_auth"] as const)(
    "rejects disallowed control bytes for %s",
    (type) => {
      const fields = type === "keyauth"
        ? { key: `valid\u0001key` }
        : type === "basicauth"
          ? { password: `valid\u0001password` }
          : { secret: `${"x".repeat(32)}\u0001` };
      expect(() => buildCredentialInput(type, fields)).toThrow("control");
    },
  );
});
