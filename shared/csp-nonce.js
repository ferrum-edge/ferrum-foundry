/**
 * The placeholder Vite writes as every `nonce` attribute in the built SPA
 * shell (`html.cspNonce`), including `<meta property="csp-nonce">`. The BFF
 * replaces it with a fresh per-response nonce, the same one its
 * `style-src` policy names (issue #594).
 */
export const CSP_NONCE_PLACEHOLDER = "__FERRUM_FOUNDRY_CSP_NONCE__";
