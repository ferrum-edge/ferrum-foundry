/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – gateway field-scoped error details                */
/* ------------------------------------------------------------------ */

/**
 * A gateway validation detail that named one request field.
 *
 * `field` is the primary request key blamed by the gateway (`cert_pem`,
 * `ca_bundle_pem`, ...). `fields` names every related control when a gateway
 * error describes a pair, so forms can mark both inputs.
 */
export interface ParsedFieldError {
  field: string;
  message: string;
  fields?: string[];
}

/**
 * Split a gateway validation detail of the form `field: message` into the
 * request key it blames and a sentence-cased message.
 *
 * `POST /admin/tls/certificates` answers unusable material with a 400 whose
 * body is `{"error":"cert_pem: no PEM certificates found"}`. Rendering that
 * raw (or worse, wrapped in ky's "Request failed with status code 400 ...
 * <url>" message) buries the one useful fact under transport noise, so forms
 * parse it and show `No PEM certificates found` under the offending textarea.
 *
 * Returns `null` unless the prefix is one of `knownFields`, so an unrelated
 * message that merely contains a colon ("bad request: try again") is never
 * mistaken for a field error and hidden inside a form control.
 */
export function parseFieldError(
  detail: string,
  knownFields: readonly string[],
): ParsedFieldError | null {
  const certificatePairPrefix = "cert_pem and key_pem do not form a valid pair:";
  const certificatePair = detail.startsWith(certificatePairPrefix);
  const validationPrefixes = [
    ["ocsp_der_base64", "ocsp_der_base64 must be valid base64:"],
    ["jwks_json", "jwks_json must be valid JSON:"],
  ] as const;
  const validationPrefix = validationPrefixes.find(([, prefix]) => detail.startsWith(prefix));
  const field = certificatePair ? "cert_pem" : validationPrefix?.[0];
  const prefix = certificatePair ? certificatePairPrefix : validationPrefix?.[1];

  if (field && prefix) {
    if (!knownFields.includes(field)) return null;
    if (certificatePair && !knownFields.includes("key_pem")) return null;
    const message = detail.slice(prefix.length).trim();
    if (!message) return null;
    return {
      field,
      message: message.charAt(0).toUpperCase() + message.slice(1),
      ...(certificatePair && { fields: ["cert_pem", "key_pem"] }),
    };
  }

  const separator = detail.indexOf(":");
  if (separator === -1) return null;

  const regularField = detail.slice(0, separator).trim();
  if (!regularField || !knownFields.includes(regularField)) return null;

  const message = detail.slice(separator + 1).trim();
  if (!message) return null;

  return { field: regularField, message: message.charAt(0).toUpperCase() + message.slice(1) };
}
