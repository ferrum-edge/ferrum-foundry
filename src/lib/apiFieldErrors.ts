/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – gateway field-scoped error details                */
/* ------------------------------------------------------------------ */

/**
 * A gateway validation detail that named one request field.
 *
 * `field` is the request key exactly as the gateway wrote it (`cert_pem`,
 * `ca_bundle_pem`, ...), so a form can attach the message to the control that
 * produced it.
 */
export interface ParsedFieldError {
  field: string;
  message: string;
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
  const separator = detail.indexOf(":");
  if (separator === -1) return null;

  const field = detail.slice(0, separator).trim();
  if (!field || !knownFields.includes(field)) return null;

  const message = detail.slice(separator + 1).trim();
  if (!message) return null;

  return { field, message: message.charAt(0).toUpperCase() + message.slice(1) };
}
