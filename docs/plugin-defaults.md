# Plugin configuration templates

The plugin picker and JSON editor use `src/lib/pluginConfigDefaults.ts` as the
single source of template configuration. Templates are starting points: replace
example endpoints, identities, keys, and policy values for your deployment.
Admission does not prove that a directory, provider, or logging destination is
reachable. Consult the [current Edge OpenAPI contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
and [plugin documentation](https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/plugins.md)
for deployment requirements.

The following templates use the current constructor fields:

| Plugin | Configuration and behavior |
| --- | --- |
| `ldap_auth` | `ldap_url` and `bind_dn_template` configure direct bind, with `{username}` in the DN. The loopback LDAP example needs a directory; use LDAPS or STARTTLS for a remote directory. Search-then-bind is a different configuration with service-account and canonical-identity fields. |
| `soap_ws_security` | `username_token.credentials`, `x509_signature.trusted_certs`, and `nonce.max_cache_size` replace the old nested shapes. Timestamp checking remains enabled; credential-based modes remain disabled. Before enabling PasswordDigest or SAML, supply credentials/trust and explicitly choose the documented replay scope. Nonce retention is gateway-controlled; there is no configurable `cache_ttl_seconds`. |
| `tcp_connection_throttle` | `max_connections_per_key: 100` limits each consumer, falling back to client IP, per gateway process. Use TCP/TCP+TLS proxy scope or a global policy covering a TCP listener. |
| `response_caching` | `cacheable_methods` and `cacheable_status_codes` retain the GET/HEAD and 200/301/404 example policy. |
| `compression` | Strong ETags are always preserved. The removed `disable_on_etag` switch is omitted. |
| `loki_logging` | `include_proxy_id_label` identifies the proxy instead of using the removed listen-path label. |
| `transaction_debugger` | `redacted_headers` adds sensitive-header redaction; body capture remains off. It is not a header-capture allowlist. |
| `ai_federation` | The removed `preserve_original_model` switch is omitted. Provider `default_model`/`model_mapping` govern model selection. |
| `ai_prompt_shield` | `patterns`, `redaction_placeholder`, and `exclude_roles` configure detection and redaction. |
| `ai_response_guard` | `pii_patterns` and `redaction_placeholder` configure response PII redaction. |
| `ai_request_guard` | The unsupported `required_fields` key is omitted; model, token, message, prompt-length, and temperature restrictions remain. |
| `ws_message_size_limiting`, `ws_rate_limiting` | `close_reason` supplies the WebSocket close text. |

Eight templates still require explicit operator configuration or gateway policy.
The contract gate records each entire error and its HTTP 400 status separately:

| Template | Expected prerequisite in the disposable gateway |
| --- | --- |
| `hmac_auth` | Declare the `ferrum-hmac-v2` replay scope for your replica topology. |
| `mtls_auth` | Supply `allowed_issuers[0].ca_certificate_pem`; an issuer name alone cannot pin trust. |
| `ai_stream_router` | Set `OPENAI_API_KEY` (then the other configured provider credentials) in the gateway environment. |
| `load_testing` | Replace the example trigger key with a key of at least 32 characters. |
| `mesh_authz` | Replace the example Kubernetes AuthorizationPolicy document with native Edge `MeshPolicy` input. The first diagnostic is `missing field name`; this is a known input-shape limitation, not evidence that the remaining policy is validated. |
| `proxy_alerts` | Set `FERRUM_ALERTS_SLACK_WEBHOOK` in the gateway environment. |
| `kafka_logging` | The default restrictive backend egress policy prevents admission of librdkafka. A missing broker is not the rejection reason. Prefer another log sink when egress must remain restricted. |
| `openapi_validator` | Select proxy scope and a proxy with an attached API spec. The gate uses proxy scope and checks the missing attached-spec diagnostic. |

## Hosted contract coverage

The existing **Pinned Gateway Contract** job runs
`scripts/gateway-contract-smoke.mjs`, which imports the real TypeScript templates
directly through Node's type stripping. It checks all 81 catalog names against
`GET /plugins`, then submits every unmodified default with `enabled: true` in a
separate disposable namespace. Each template is deleted before the next is
submitted, avoiding composition with the demo seed or another template. TCP
throttling gets a TCP proxy fixture; OpenAPI validation gets an HTTP proxy fixture.

The expected result is 73 HTTP 201 admissions (the previous 60 controls plus the
13 repaired defaults) and the eight exact prerequisite rejections above. Accepted
plugins are read back as enabled. Unexpected success, a changed error body or
status, a missing/extra catalog member, or failed cleanup fails the gate. Admission
failures are collected across the catalog; cleanup failure stops further probes
because isolation is no longer assured. The contract transport tests exercise
unexpected acceptance, unknown-key diagnostics, status changes, and cleanup.

The job retains its existing image digest
`sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`.
Issue #291's reproduction used a different digest (`sha256:f2c3eb7696677fed4a90551c7c8adfccae547c0e540452011f98a53b34233c2d`).
Constructor/schema inspection used Edge main revision
`b89d132fbddb1ed7b705e32332d7c606ea8a69c0`; it does not establish the source
identity of either image. Hosted results establish compatibility with the pinned
image, not with every newer Edge release. Any divergence must be reviewed as a
compatibility dependency; do not broaden the rejection table or silently change
the image pin to make a failure disappear.
