import { REDACTED } from "@/api/types";
import type {
  BuiltInCredentialType,
  ConsumerCredentialInput,
} from "@/api/types";

const PASSWORD_HASH = /^hmac_sha256:[0-9a-f]{64}$/;

export class CredentialInputError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "CredentialInputError";
  }
}

function requireLength(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): void {
  const length = Array.from(value).length;
  if (length < minimum || length > maximum) {
    throw new CredentialInputError(
      `${field} must be ${minimum}-${maximum} characters`,
      field,
    );
  }
}

function rejectControls(value: string, field: string): void {
  const hasDisallowedControl = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
  });
  if (hasDisallowedControl) {
    throw new CredentialInputError(
      `${field} contains a disallowed control character`,
      field,
    );
  }
}

function nonWhitespaceCharacterCount(value: string): number {
  return Array.from(value).filter((character) => character.trim().length > 0).length;
}

/**
 * Build a strict canonical credential object. The output contains only schema
 * fields, and secret bytes are deliberately not trimmed or normalized.
 */
export function buildCredentialInput(
  type: BuiltInCredentialType,
  fields: Readonly<Record<string, string | undefined>>,
): ConsumerCredentialInput {
  switch (type) {
    case "keyauth": {
      const key = fields.key ?? "";
      requireLength(key, "API key", 1, 4096);
      if (!key.trim()) {
        throw new CredentialInputError("API key cannot be only whitespace", "key");
      }
      rejectControls(key, "API key");
      if (key === REDACTED) {
        throw new CredentialInputError(
          `${REDACTED} is reserved for redacted responses`,
          "key",
        );
      }
      return { key };
    }

    case "basicauth": {
      const password = fields.password;
      const passwordHash = fields.password_hash;
      if (password !== undefined && passwordHash !== undefined) {
        throw new CredentialInputError(
          "Provide either a password or a password hash, not both",
          "password",
        );
      }
      if (passwordHash !== undefined) {
        if (!PASSWORD_HASH.test(passwordHash)) {
          throw new CredentialInputError(
            "Password hash must use hmac_sha256:<64 lowercase hex>",
            "password_hash",
          );
        }
        return { password_hash: passwordHash };
      }
      const exactPassword = password ?? "";
      requireLength(exactPassword, "Password", 1, 4096);
      rejectControls(exactPassword, "Password");
      return { password: exactPassword };
    }

    case "jwt": {
      const secret = fields.secret ?? "";
      requireLength(secret, "JWT secret", 32, 4096);
      rejectControls(secret, "JWT secret");
      return { secret };
    }

    case "hmac_auth": {
      const secret = fields.secret ?? "";
      requireLength(secret, "HMAC secret", 32, 4096);
      rejectControls(secret, "HMAC secret");
      if (nonWhitespaceCharacterCount(secret) < 32) {
        throw new CredentialInputError(
          "HMAC secret must contain at least 32 non-whitespace characters",
          "secret",
        );
      }
      return { secret };
    }

    case "mtls_auth": {
      const identity = fields.identity ?? "";
      requireLength(identity, "mTLS identity", 1, 4096);
      if (!identity.trim()) {
        throw new CredentialInputError("mTLS identity cannot be only whitespace", "identity");
      }
      rejectControls(identity, "mTLS identity");
      return { identity };
    }
  }
}
