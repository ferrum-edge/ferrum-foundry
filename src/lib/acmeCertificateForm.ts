import type {
  AcmeCertificateRecord,
  AcmeCertificateRequest,
} from "@/api/tls";

export interface AcmeCertificateFormState {
  id: string;
  domains: string;
  directoryUrl: string;
  accountId: string;
  orderUrl: string;
  certPem: string;
  keyPem: string;
  chainPem: string;
  allowOverwrite: boolean;
  allowExpired: boolean;
  expiryWarningDays: string;
}

export const EMPTY_ACME_CERTIFICATE_FORM: AcmeCertificateFormState = {
  id: "",
  domains: "",
  directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
  accountId: "",
  orderUrl: "",
  certPem: "",
  keyPem: "",
  chainPem: "",
  allowOverwrite: false,
  allowExpired: false,
  expiryWarningDays: "30",
};

export class AcmeCertificateFormError extends Error {}

function validateHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AcmeCertificateFormError(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AcmeCertificateFormError(
      `${label} must be an absolute HTTPS URL without credentials or a fragment`,
    );
  }
  return url.toString();
}

function validateCertificatePem(value: string, label: string): string {
  const material = value.trim();
  if (
    !material.startsWith("-----BEGIN CERTIFICATE-----") ||
    !material.endsWith("-----END CERTIFICATE-----")
  ) {
    throw new AcmeCertificateFormError(`${label} must be complete CERTIFICATE PEM`);
  }
  return material;
}

function validatePrivateKeyPem(value: string): string {
  const material = value.trim();
  const match = material.match(
    /^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----[\s\S]+-----END \1-----$/,
  );
  if (!match) {
    throw new AcmeCertificateFormError(
      "Private key must be complete PRIVATE KEY, RSA PRIVATE KEY, or EC PRIVATE KEY PEM",
    );
  }
  return material;
}

export function buildAcmeCertificateRequest(
  form: AcmeCertificateFormState,
): AcmeCertificateRequest {
  const domains = [...new Set(
    form.domains
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean),
  )];
  if (domains.length === 0) {
    throw new AcmeCertificateFormError("At least one certificate domain is required");
  }
  if (domains.some((domain) => /\s|:\/\//.test(domain))) {
    throw new AcmeCertificateFormError("Certificate domains must be DNS identifiers, not URLs");
  }
  const expiryWarningDays = Number(form.expiryWarningDays);
  if (!Number.isSafeInteger(expiryWarningDays) || expiryWarningDays < 0) {
    throw new AcmeCertificateFormError("Expiry warning days must be a non-negative integer");
  }

  return {
    ...(form.id.trim() && { id: form.id.trim() }),
    domains,
    directory_url: validateHttpsUrl(form.directoryUrl.trim(), "Directory URL"),
    ...(form.accountId.trim() && { account_id: form.accountId.trim() }),
    ...(form.orderUrl.trim() && {
      order_url: validateHttpsUrl(form.orderUrl.trim(), "Order URL"),
    }),
    cert_pem: validateCertificatePem(form.certPem, "Leaf certificate"),
    key_pem: validatePrivateKeyPem(form.keyPem),
    ...(form.chainPem.trim() && {
      chain_pem: validateCertificatePem(form.chainPem, "Certificate chain"),
    }),
    allow_overwrite: form.allowOverwrite,
    allow_expired: form.allowExpired,
    cert_expiry_warning_days: expiryWarningDays,
  };
}

export function acmeCertificateToForm(
  certificate: AcmeCertificateRecord,
): AcmeCertificateFormState {
  return {
    ...EMPTY_ACME_CERTIFICATE_FORM,
    id: certificate.id,
    domains: certificate.domains.join(", "),
    directoryUrl: certificate.directory_url,
    accountId: certificate.account_id ?? "",
    orderUrl: certificate.order_url ?? "",
    allowOverwrite: true,
  };
}
