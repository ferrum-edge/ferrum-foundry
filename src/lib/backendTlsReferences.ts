/**
 * Edge v0.9.15 (ferrum-edge#6092, PR #6094): where the admin `ns` claim is
 * enforced, an `operator` may set `backend_tls_client_cert_path`,
 * `backend_tls_client_key_path` and `backend_tls_server_ca_cert_path` only to
 * inline PEM, `system://`, or a `k8s://` Secret in the addressed namespace.
 * Anything else is refused with `400` before it is loaded; values already
 * stored on the resource are kept, and `admin` tokens are unaffected.
 *
 * Foundry cannot tell whether a gateway enforces the claim, so it states the
 * rule and shows Edge's refusal as returned rather than refusing locally.
 */
export const BACKEND_TLS_OPERATOR_SCOPE_NOTE =
  "Where the gateway enforces namespace claims, an operator can set these only " +
  "to inline PEM, system://, or a k8s:// Secret in this namespace; file paths " +
  "and secret-manager references need an admin. Values already stored are kept.";
