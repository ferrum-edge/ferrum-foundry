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
| `ldap_auth` | `ldap_url`, `bind_dn_template`, and `canonical_identity_attribute` configure direct bind, with `{username}` in the DN. Set `canonical_identity_attribute` to your directory's authoritative attribute (`uid` in the example). The loopback LDAP example needs a directory; use LDAPS or STARTTLS for a remote directory. Search-then-bind is a different configuration with service-account fields. |
| `mcp_gateway` | Aggregate-router mode exposes endpoint, upstream `servers`, and tool `policy`. `discovery.public_base_url` belongs to the A2A gateway schema and is omitted from the MCP template. |
| `soap_ws_security` | `username_token.credentials`, `x509_signature.trusted_certs`, and `nonce.max_cache_size` replace the old nested shapes. Timestamp checking remains enabled; credential-based modes remain disabled. Before enabling PasswordDigest or SAML, supply credentials/trust and explicitly choose the documented replay scope. Nonce retention is gateway-controlled; there is no configurable `cache_ttl_seconds`. |
| `tcp_connection_throttle` | `max_connections_per_key: 100` limits each consumer, falling back to client IP, per gateway process. Use TCP/TCP+TLS proxy scope or a global policy covering a TCP listener. |
| `response_caching` | `cacheable_methods` and `cacheable_status_codes` retain the GET/HEAD and 200/301/404 example policy. |
| `compression` | Strong ETags are always preserved. The removed `disable_on_etag` switch is omitted. |
| `loki_logging` | `include_proxy_id_label` identifies the proxy instead of using the removed listen-path label. |
| `transaction_debugger` | `redacted_headers` adds sensitive-header redaction; body capture remains off. It is not a header-capture allowlist. |
| `ai_federation` | The removed `preserve_original_model` switch is omitted. Provider `default_model`/`model_mapping` govern model selection. |
| `ai_prompt_shield` | `patterns`, `redaction_placeholder`, and `exclude_roles` configure detection and redaction. The built-in US phone token is `phone_us`; `phone` is invalid. |
| `ai_response_guard` | `pii_patterns` and `redaction_placeholder` configure response PII redaction, using the same `phone_us` token. |
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
| `kafka_logging` | The default restrictive backend egress policy prevents admission of librdkafka during field validation. Its exact error starts with `Invalid plugin config fields: kafka_logging:`, before plugin construction or broker contact. Prefer another log sink when egress must remain restricted. |
| `openapi_validator` | Select proxy scope and a proxy with an attached API spec. The gate uses proxy scope and checks the missing attached-spec diagnostic. |

## Hosted contract coverage

The existing **Pinned Gateway Contract** job runs
`scripts/gateway-contract-smoke.mjs`, which imports the real TypeScript templates
directly through Node's type stripping. It checks all 81 catalog names against
`GET /plugins`, then submits every unmodified default with `enabled: true` in a
separate disposable namespace. The smoke runs **before both demo seeds**, because
the enabled demo `prometheus_metrics` fixture owns a process-wide registry even
across namespaces. Each template is deleted before the next is submitted. TCP
throttling gets a TCP proxy fixture; OpenAPI validation gets an HTTP proxy fixture.
After catalog cleanup, the job still seeds twice, verifies canonical backup state
(including the exact enabled demo Prometheus fixture), and checks demo routes.
It never disables or deletes unknown fixtures to make room for the catalog.

The expected result is 73 HTTP 201 admissions (the previous 60 controls plus the
13 repaired defaults) and the eight exact prerequisite rejections above. Accepted
plugins are read back as enabled. Unexpected success, a changed error body or
status, a missing/extra catalog member, or failed cleanup fails the gate. Admission
failures are collected across the catalog; cleanup failure stops further probes
because isolation is no longer assured. The contract transport tests exercise
unexpected acceptance, unknown-key diagnostics, status changes, and cleanup,
including simultaneous admission/cleanup failures and rejecting Prometheus 409s.

The job retains its existing image digest
`sha256:fb0f05b0392a272ba36a493584bced171655ce8ebd36b2ae0818bb5c3c25ef2d`.
Issue #291's reproduction used a different digest (`sha256:f2c3eb7696677fed4a90551c7c8adfccae547c0e540452011f98a53b34233c2d`).
The pinned digest was published from Edge revision
`b96cfaadd41a676d39a409d47b48e0b0588fa86e`: the
[Docker Manifest job](https://github.com/ferrum-edge/ferrum-edge/actions/runs/33094251786/job/98636370391)
records that digest for the corresponding `main-b96cfa...` tag. At that revision,
both guards call the shared
[built-in PII pattern table](https://github.com/ferrum-edge/ferrum-edge/blob/b96cfaadd41a676d39a409d47b48e0b0588fa86e/src/plugins/utils/ai_pii.rs#L45),
which defines `phone_us`. Kafka's
[egress screening](https://github.com/ferrum-edge/ferrum-edge/blob/b96cfaadd41a676d39a409d47b48e0b0588fa86e/src/plugins/kafka_logging.rs#L339)
returns the restrictive-policy diagnostic through the admin
[field-validation boundary](https://github.com/ferrum-edge/ferrum-edge/blob/b96cfaadd41a676d39a409d47b48e0b0588fa86e/src/admin/crud.rs#L3827).
The [initial Foundry contract run](https://github.com/ferrum-edge/ferrum-foundry/actions/runs/34172111334/job/101894263227)
confirmed the complete Kafka diagnostic and exposed the invalid phone tokens and
seeded Prometheus conflict. Hosted results establish compatibility with the pinned
image, not with every newer Edge release. Any divergence must be reviewed as a
compatibility dependency; do not broaden the rejection table or silently change
the image pin to make a failure disappear.
