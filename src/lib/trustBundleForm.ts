import type {
  GatewayTrustBundle,
  GatewayTrustBundleCreate,
  TrustBundle,
  TrustBundleJwtAuthority,
} from "@/api/trust";

export interface TrustBundleFormState {
  id: string;
  trustDomain: string;
  x509Authorities: string;
  jwtAuthorities: string;
  federatedBundles: string;
  refreshHintSeconds: string;
}

export const EMPTY_TRUST_BUNDLE_FORM: TrustBundleFormState = {
  id: "",
  trustDomain: "",
  x509Authorities: "",
  jwtAuthorities: "[]",
  federatedBundles: "[]",
  refreshHintSeconds: "",
};

export class TrustBundleFormError extends Error {}

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

function parseJsonArray(value: string, label: string): unknown[] {
  if (!value.trim()) return [];
  if (value.length > 512 * 1024) {
    throw new TrustBundleFormError(`${label} exceeds the 512 KiB bundle limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TrustBundleFormError(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new TrustBundleFormError(`${label} must be a JSON array`);
  }
  return parsed;
}

function validateTrustDomain(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TrustBundleFormError(`${label} is required`);
  }
  const domain = value.trim();
  if (domain.includes("://") || /\s/.test(domain)) {
    throw new TrustBundleFormError(
      `${label} must be a trust domain without a URI scheme or whitespace`,
    );
  }
  return domain;
}

function validateBase64Der(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TrustBundleFormError(`${label} must be a non-empty base64 DER certificate`);
  }
  const encoded = value.trim();
  if (encoded.length > 21_848) {
    throw new TrustBundleFormError(`${label} exceeds the 16 KiB decoded limit`);
  }
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new TrustBundleFormError(`${label} is not valid base64 DER`);
  }
  let decodedLength = 0;
  try {
    decodedLength = atob(encoded).length;
  } catch {
    throw new TrustBundleFormError(`${label} is not valid base64 DER`);
  }
  if (decodedLength === 0 || decodedLength > 16 * 1024) {
    throw new TrustBundleFormError(`${label} must decode to 1–16384 bytes`);
  }
  return encoded;
}

function validatePublicKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TrustBundleFormError(`${label} is required`);
  }
  const material = value.trim();
  if (material.length > 16 * 1024) {
    throw new TrustBundleFormError(`${label} exceeds 16 KiB`);
  }
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(material)) {
    throw new TrustBundleFormError(`${label} must not contain a private key`);
  }
  if (
    material.startsWith("-----BEGIN PUBLIC KEY-----") &&
    material.endsWith("-----END PUBLIC KEY-----")
  ) {
    return material;
  }
  try {
    const jwk = JSON.parse(material) as unknown;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new Error();
    const record = jwk as Record<string, unknown>;
    if (PRIVATE_JWK_MEMBERS.some((member) => member in record)) {
      throw new TrustBundleFormError(
        `${label} JWK must not contain private or symmetric key material`,
      );
    }
    return material;
  } catch (error) {
    if (error instanceof TrustBundleFormError) throw error;
    throw new TrustBundleFormError(
      `${label} must be an SPKI PUBLIC KEY PEM or a public JWK object`,
    );
  }
}

function validateJwtAuthorities(
  value: unknown,
  label: string,
): TrustBundleJwtAuthority[] {
  if (!Array.isArray(value)) {
    throw new TrustBundleFormError(`${label} must be an array`);
  }
  if (value.length > 16) {
    throw new TrustBundleFormError(`${label} can contain at most 16 authorities`);
  }
  const keyIds = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TrustBundleFormError(`${label}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key_id !== "string" || !record.key_id.trim()) {
      throw new TrustBundleFormError(`${label}[${index}].key_id is required`);
    }
    const keyId = record.key_id.trim();
    if (keyId.length > 256) {
      throw new TrustBundleFormError(`${label}[${index}].key_id exceeds 256 characters`);
    }
    if (keyIds.has(keyId)) {
      throw new TrustBundleFormError(`${label} contains duplicate key_id ${keyId}`);
    }
    keyIds.add(keyId);
    return {
      key_id: keyId,
      public_key_pem: validatePublicKey(
        record.public_key_pem,
        `${label}[${index}].public_key_pem`,
      ),
    };
  });
}

function validateBundle(value: unknown, label: string): TrustBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrustBundleFormError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const trustDomain = validateTrustDomain(record.trust_domain, `${label}.trust_domain`);
  const x509Input = record.x509_authorities ?? [];
  if (!Array.isArray(x509Input)) {
    throw new TrustBundleFormError(`${label}.x509_authorities must be an array`);
  }
  if (x509Input.length > 16) {
    throw new TrustBundleFormError(`${label} can contain at most 16 X.509 authorities`);
  }
  const x509Authorities = x509Input.map((entry, index) =>
    validateBase64Der(entry, `${label}.x509_authorities[${index}]`),
  );
  if (new Set(x509Authorities).size !== x509Authorities.length) {
    throw new TrustBundleFormError(`${label} contains duplicate X.509 authorities`);
  }
  const jwtAuthorities = validateJwtAuthorities(
    record.jwt_authorities ?? [],
    `${label}.jwt_authorities`,
  );
  if (x509Authorities.length === 0 && jwtAuthorities.length === 0) {
    throw new TrustBundleFormError(`${label} requires at least one X.509 or JWT authority`);
  }
  let refreshHintSeconds: number | undefined;
  if (record.refresh_hint_seconds !== undefined) {
    if (
      typeof record.refresh_hint_seconds !== "number" ||
      !Number.isSafeInteger(record.refresh_hint_seconds) ||
      record.refresh_hint_seconds < 0
    ) {
      throw new TrustBundleFormError(`${label}.refresh_hint_seconds must be a non-negative integer`);
    }
    refreshHintSeconds = record.refresh_hint_seconds;
  }
  return {
    trust_domain: trustDomain,
    ...(x509Authorities.length > 0 && { x509_authorities: x509Authorities }),
    ...(jwtAuthorities.length > 0 && { jwt_authorities: jwtAuthorities }),
    ...(refreshHintSeconds !== undefined && { refresh_hint_seconds: refreshHintSeconds }),
  };
}

export function buildTrustBundlePayload(
  form: TrustBundleFormState,
  expectedRevision?: number,
): GatewayTrustBundleCreate {
  const trustDomain = validateTrustDomain(form.trustDomain, "Trust domain");
  const x509Authorities = form.x509Authorities
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => validateBase64Der(value, `X.509 authority ${index + 1}`));
  if (x509Authorities.length > 16) {
    throw new TrustBundleFormError("Local bundle can contain at most 16 X.509 authorities");
  }
  if (new Set(x509Authorities).size !== x509Authorities.length) {
    throw new TrustBundleFormError("Local bundle contains duplicate X.509 authorities");
  }
  const jwtAuthorities = validateJwtAuthorities(
    parseJsonArray(form.jwtAuthorities, "JWT authorities"),
    "JWT authorities",
  );

  let refreshHintSeconds: number | undefined;
  if (form.refreshHintSeconds.trim()) {
    refreshHintSeconds = Number(form.refreshHintSeconds);
    if (!Number.isSafeInteger(refreshHintSeconds) || refreshHintSeconds < 0) {
      throw new TrustBundleFormError("Refresh hint must be a non-negative integer");
    }
  }
  if (x509Authorities.length === 0 && jwtAuthorities.length === 0) {
    throw new TrustBundleFormError("Local bundle requires at least one X.509 or JWT authority");
  }

  const federatedInput = parseJsonArray(form.federatedBundles, "Federated bundles");
  if (federatedInput.length > 256) {
    throw new TrustBundleFormError("At most 256 federated bundles are allowed");
  }
  const federated = federatedInput.map((entry, index) =>
    validateBundle(entry, `Federated bundle ${index + 1}`),
  );
  const domains = new Set([trustDomain]);
  for (const entry of federated) {
    if (domains.has(entry.trust_domain)) {
      throw new TrustBundleFormError(
        `Trust domain ${entry.trust_domain} is duplicated across local/federated bundles`,
      );
    }
    domains.add(entry.trust_domain);
  }

  const authorityOwners = new Map<string, string>();
  const ensureUnambiguous = (entry: TrustBundle) => {
    for (const authority of entry.x509_authorities ?? []) {
      const key = `x509:${authority}`;
      const owner = authorityOwners.get(key);
      if (owner && owner !== entry.trust_domain) {
        throw new TrustBundleFormError(
          `X.509 authority is ambiguous between ${owner} and ${entry.trust_domain}`,
        );
      }
      authorityOwners.set(key, entry.trust_domain);
    }
  };
  ensureUnambiguous({
    trust_domain: trustDomain,
    x509_authorities: x509Authorities,
    jwt_authorities: jwtAuthorities,
  });
  for (const entry of federated) ensureUnambiguous(entry);

  const payload: GatewayTrustBundleCreate = {
    ...(form.id.trim() && { id: form.id.trim() }),
    trust_domain: trustDomain,
    bundle: {
      local: {
        trust_domain: trustDomain,
        ...(x509Authorities.length > 0 && { x509_authorities: x509Authorities }),
        ...(jwtAuthorities.length > 0 && { jwt_authorities: jwtAuthorities }),
        ...(refreshHintSeconds !== undefined && { refresh_hint_seconds: refreshHintSeconds }),
      },
      ...(federated.length > 0 && { federated }),
    },
    ...(expectedRevision !== undefined && { revision: expectedRevision }),
  };
  if (JSON.stringify(payload).length > 512 * 1024) {
    throw new TrustBundleFormError("Encoded trust bundle exceeds 512 KiB");
  }
  return payload;
}

export function trustBundleToForm(bundle: GatewayTrustBundle): TrustBundleFormState {
  return {
    id: bundle.id,
    trustDomain: bundle.trust_domain,
    x509Authorities: (bundle.bundle.local.x509_authorities ?? []).join("\n"),
    jwtAuthorities: JSON.stringify(bundle.bundle.local.jwt_authorities ?? [], null, 2),
    federatedBundles: JSON.stringify(bundle.bundle.federated ?? [], null, 2),
    refreshHintSeconds:
      bundle.bundle.local.refresh_hint_seconds === undefined
        ? ""
        : String(bundle.bundle.local.refresh_hint_seconds),
  };
}
